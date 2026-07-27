import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertTarget, normalizeTarget } from './runtime-target.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');
const codegraphRoot = resolve(extensionRoot, '..');
const requestedTarget = process.argv[2] ?? normalizeTarget();
const target = assertTarget(requestedTarget);
const runtimeRoot = join(extensionRoot, 'runtime');
const destination = join(runtimeRoot, target);
const archiveExtension = target.startsWith('win32-') ? '.zip' : '.tar.gz';
const archive = join(codegraphRoot, 'release', `codegraph-${target}${archiveExtension}`);
const hostTarget = normalizeTarget();
const requireKernel = process.env.CODEGRAPH_REQUIRE_NATIVE_KERNEL === '1';

function run(command, args, cwd = codegraphRoot) {
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

mkdirSync(runtimeRoot, { recursive: true });

if (target === hostTarget && process.env.CODEGRAPH_SKIP_NATIVE_KERNEL !== '1') {
  const cargo = spawnSync('cargo', ['--version'], {
    cwd: codegraphRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (cargo.status === 0) {
    console.log(`[runtime] building native Rust kernel for ${target}`);
    run('bash', [join(codegraphRoot, 'scripts', 'build-kernel.sh')]);
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

run('bash', [join(codegraphRoot, 'scripts', 'build-bundle.sh'), target]);

if (!existsSync(archive)) {
  throw new Error(`CodeGraph bundle was not created: ${archive}`);
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
  run(
    'tar',
    ['-xzf', archive, '--strip-components=1', '-C', destination],
    extensionRoot,
  );
  chmodSync(join(destination, 'node'), 0o755);
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
