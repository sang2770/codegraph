import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { markExecutable } from './runtime-permissions.mjs';
import { assertTarget, normalizeTarget } from './runtime-target.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');
const engineRoot = resolve(extensionRoot, '..');
const requestedTarget = process.argv[2] ?? normalizeTarget();
const target = assertTarget(requestedTarget);
const runtimeRoot = join(extensionRoot, 'runtime');
const destination = join(runtimeRoot, target);
const archiveExtension = target.startsWith('win32-') ? '.zip' : '.tar.gz';
const archive = join(engineRoot, 'release', `codegraph-${target}${archiveExtension}`);
const hostTarget = normalizeTarget();
const requireKernel = process.env.CODEGRAPH_REQUIRE_NATIVE_KERNEL === '1';
const gitBashPath = join(
  process.env.ProgramFiles ?? 'C:\\Program Files',
  'Git',
  'bin',
  'bash.exe',
);
const bashCommand =
  process.platform === 'win32' && existsSync(gitBashPath)
    ? gitBashPath
    : 'bash';

function run(command, args, cwd = engineRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function tarPath(filePath) {
  if (process.platform !== 'win32') {
    return filePath;
  }

  const drivePath = filePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePath) {
    return `/${drivePath[1].toLowerCase()}/${drivePath[2].replaceAll('\\', '/')}`;
  }
  return filePath.replaceAll('\\', '/');
}

mkdirSync(runtimeRoot, { recursive: true });

if (target === hostTarget && process.env.CODEGRAPH_SKIP_NATIVE_KERNEL !== '1') {
  const cargo = spawnSync('cargo', ['--version'], {
    cwd: engineRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (cargo.status === 0) {
    console.log(`[runtime] building native Rust kernel for ${target}`);
    // `--platform` is passed rather than letting build-kernel.sh read the host
    // from `uname`: on Windows ARM, Git Bash is the x64 MSYS build running
    // under emulation, so `uname -m` says `x86_64`. cargo still produces a
    // correct arm64 binary, but it would be staged under `prebuilds/win32-x64`
    // and the arm64 bundle would then find no kernel and silently fall back to
    // WASM. This target is the host target — the `if` above guarantees it — so
    // naming it here is exactly the label the build deserves.
    run(bashCommand, [
      tarPath(join(engineRoot, 'scripts', 'build-kernel.sh')),
      '--platform',
      target,
    ]);
  } else if (requireKernel) {
    throw new Error(
      'A Rust toolchain is required because CODEGRAPH_REQUIRE_NATIVE_KERNEL=1.',
    );
  } else {
    console.warn(
      `[runtime] cargo is unavailable; ${target} will use the WASM extraction fallback`,
    );
  }
}

run(bashCommand, [tarPath(join(engineRoot, 'scripts', 'build-bundle.sh')), target]);

if (!existsSync(archive)) {
  throw new Error(`CodeBrain engine bundle was not created: ${archive}`);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

if (target.startsWith('win32-')) {
  const staging = join(runtimeRoot, `.extract-${target}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const unzip = spawnSync('unzip', ['-q', archive, '-d', staging], {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (unzip.error && 'code' in unzip.error && unzip.error.code === 'ENOENT') {
    run('tar', ['-xf', archive, '-C', staging], extensionRoot);
  } else if (unzip.error) {
    throw unzip.error;
  } else if (unzip.status !== 0) {
    throw new Error(`unzip exited with status ${String(unzip.status)}`);
  }
  cpSync(join(staging, `codegraph-${target}`), destination, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
} else {
  // Invoke tar from Git Bash as well. The Windows tar.exe may not understand
  // Git Bash drive paths such as /d/... even though the archive was created
  // successfully by the Bash build script.
  run(
    bashCommand,
    [
      '-lc',
      'tar -xzf "$1" --strip-components=1 -C "$2"',
      'build-runtime',
      tarPath(archive),
      tarPath(destination),
    ],
    extensionRoot,
  );
  markExecutable(destination, target);
}

const bundledKernel = join(destination, 'lib', 'kernel', 'codegraph-kernel.node');
if (!existsSync(bundledKernel) && requireKernel) {
  throw new Error(`Native kernel was not bundled for ${target}: ${bundledKernel}`);
}
console.log(
  existsSync(bundledKernel)
    ? `[runtime] verified native Rust kernel for ${target}`
    : `[runtime] native kernel absent for ${target}; WASM fallback remains available`,
);
console.log(`[runtime] staged ${target} at ${destination}`);
