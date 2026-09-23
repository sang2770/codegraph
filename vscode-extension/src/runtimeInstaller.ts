/**
 * Installing and updating the CodeGraph runtime from npm.
 *
 * The extension no longer ships a runtime inside the `.vsix`. It installs the
 * published `@xuansang2770/codegraph` package into its own global storage
 * instead, and keeps it current. The package is a thin shim whose real payload
 * is a per-platform optional dependency, `@xuansang2770/codegraph-<target>`,
 * holding a vendored Node plus the app — exactly the `node`, `lib/`, `bin/`
 * layout the old bundled `runtime/<target>/` had, so everything downstream runs
 * it the same way.
 *
 * Layout under the storage root:
 *
 *   runtime/
 *     current.json                       { version, dir } — the active install
 *     <version>/node_modules/@xuansang2770/codegraph-<target>/
 *                                        node | node.exe, lib/, bin/
 *
 * One directory per version, never an in-place upgrade: an MCP server started
 * by another window or another agent keeps its files open (and on Windows,
 * locked), so the new version lands next to the old one and only the pointer
 * moves. Installs go to a temp directory first and are renamed into place, so
 * two windows racing to install the same version cannot leave a half-written
 * tree behind — the loser's rename fails and its copy is discarded.
 *
 * Two ways to fetch, tried in order:
 *
 *  - **npm**, when it is on PATH. It honours the user's `.npmrc` — a corporate
 *    registry, a proxy, an auth token — which a hand-rolled HTTP client would
 *    not know about.
 *  - **Direct download** from the registry otherwise: the platform package's
 *    tarball, checked against its published integrity hash and unpacked with
 *    the system `tar` (present on macOS, Linux and Windows 10+).
 *
 * No `vscode` import: this runs under plain `node --test`.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { join } from 'node:path';

export const RUNTIME_PACKAGE = '@xuansang2770/codegraph';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

const CURRENT_FILE = 'current.json';
const NETWORK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const NPM_TIMEOUT_MS = 15 * 60_000;
/** An install temp directory untouched this long was left by a crashed install. */
const ABANDONED_TEMP_MS = 60 * 60_000;

export type Log = (message: string) => void;

/** The platform half of the package name, e.g. `linux-x64`. */
export function runtimeTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  if (
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    (arch !== 'x64' && arch !== 'arm64')
  ) {
    throw new Error(`CodeBrain has no CodeGraph runtime for ${platform}-${arch}.`);
  }
  return `${platform}-${arch}`;
}

export function platformPackage(target: string): string {
  return `${RUNTIME_PACKAGE}-${target}`;
}

// ------------------------------------------------------------------ versions

/** `1.6.1` / `v1.6.1` / `1.7.0-beta.2` → comparable parts; `undefined` if not semver. */
function parseVersion(version: string): { core: number[]; pre: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' };
}

export function isExactVersion(spec: string): boolean {
  return parseVersion(spec) !== undefined;
}

/**
 * Semver ordering, enough for release versions: a pre-release sorts below its
 * release, and pre-release tags compare as plain strings (the only ones this
 * package publishes are `-beta.N`, `-rc.N`).
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return a.localeCompare(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
}

// ------------------------------------------------------------------- layout

export interface InstalledRuntime {
  version: string;
  /** Directory holding `node`, `lib/` and `bin/`. */
  dir: string;
}

export function versionRoot(storageRoot: string, version: string): string {
  return join(storageRoot, version);
}

export function runtimeDirFor(storageRoot: string, version: string, target: string): string {
  return join(versionRoot(storageRoot, version), 'node_modules', ...platformPackage(target).split('/'));
}

/** The files a runtime directory must hold before it may become current. */
export function missingRuntimeFiles(dir: string, platform: string = process.platform): string[] {
  const required = [
    platform === 'win32' ? 'node.exe' : 'node',
    join('lib', 'dist', 'bin', 'codegraph.js'),
  ];
  return required.filter((relative) => !existsSync(join(dir, relative)));
}

/** The active install, when the pointer names a directory that still exists intact. */
export function readCurrent(storageRoot: string): InstalledRuntime | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(storageRoot, CURRENT_FILE), 'utf8')) as Partial<InstalledRuntime>;
    if (typeof parsed.version !== 'string' || typeof parsed.dir !== 'string') return undefined;
    if (missingRuntimeFiles(parsed.dir).length > 0) return undefined;
    return { version: parsed.version, dir: parsed.dir };
  } catch {
    return undefined;
  }
}

export function writeCurrent(storageRoot: string, installed: InstalledRuntime): void {
  mkdirSync(storageRoot, { recursive: true });
  const path = join(storageRoot, CURRENT_FILE);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(installed, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/**
 * Delete every installed version except the ones named. Best-effort: a
 * version another window or agent is still running stays locked on Windows,
 * and is simply retried on the next prune.
 */
export function pruneRuntimes(storageRoot: string, keep: readonly string[], log: Log = () => {}): void {
  let entries: string[];
  try {
    entries = readdirSync(storageRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === CURRENT_FILE || keep.includes(entry)) continue;
    // Only ever touch what this module created: version directories and its
    // own abandoned temp directories.
    if (!isExactVersion(entry) && !entry.startsWith('.tmp-')) continue;
    // A fresh temp directory is another window's install still in progress.
    if (entry.startsWith('.tmp-') && !isAbandoned(join(storageRoot, entry))) continue;
    try {
      rmSync(join(storageRoot, entry), { recursive: true, force: true });
      log(`removed old runtime ${entry}`);
    } catch (error) {
      log(`could not remove ${entry} yet — ${describe(error)}`);
    }
  }
}

function isAbandoned(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ABANDONED_TEMP_MS;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ registry access

export interface RegistryOptions {
  /** Registry base URL; ends with `/`. */
  registry: string;
  log: Log;
}

/** The npm command for this platform, or `undefined` when there is none on PATH. */
export async function findNpm(): Promise<string | undefined> {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    await runCommand(command, ['--version'], { timeoutMs: 20_000 });
    return command;
  } catch {
    return undefined;
  }
}

/** The registry npm itself would use, so a direct download follows `.npmrc`. */
export async function npmRegistry(npm: string): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand(npm, ['config', 'get', 'registry'], { timeoutMs: 20_000 });
    const registry = stdout.trim();
    return /^https?:\/\//.test(registry) ? withTrailingSlash(registry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a spec (`latest`, a dist-tag, or an exact version) to a version.
 * npm first when available — it is the one that knows about registry auth —
 * then the registry's JSON API.
 */
export async function resolveVersion(
  spec: string,
  options: RegistryOptions & { npm?: string },
): Promise<string> {
  if (options.npm) {
    try {
      const { stdout } = await runCommand(
        options.npm,
        ['view', `${RUNTIME_PACKAGE}@${spec}`, 'version', '--json'],
        { timeoutMs: NETWORK_TIMEOUT_MS * 2 },
      );
      const parsed = JSON.parse(stdout) as unknown;
      // A range can match several versions; npm then returns an array.
      const version = Array.isArray(parsed) ? String(parsed[parsed.length - 1]) : String(parsed);
      if (isExactVersion(version)) return version;
    } catch (error) {
      options.log(`npm could not resolve ${RUNTIME_PACKAGE}@${spec} — ${describe(error)}; asking the registry directly`);
    }
  }

  const metadata = (await getJson(`${options.registry}${encodePackage(RUNTIME_PACKAGE)}`)) as {
    'dist-tags'?: Record<string, string>;
    versions?: Record<string, unknown>;
  };
  if (isExactVersion(spec)) {
    const exact = spec.replace(/^v/, '');
    if (metadata.versions && !(exact in metadata.versions)) {
      throw new Error(`${RUNTIME_PACKAGE}@${exact} is not published on ${options.registry}.`);
    }
    return exact;
  }
  const tagged = metadata['dist-tags']?.[spec];
  if (!tagged) throw new Error(`${RUNTIME_PACKAGE} has no "${spec}" tag on ${options.registry}.`);
  return tagged;
}

// ------------------------------------------------------------------ install

export interface InstallOptions extends RegistryOptions {
  storageRoot: string;
  version: string;
  target?: string;
  npm?: string;
}

/**
 * Install one version and return where it landed. A version already present
 * and intact is returned as-is — installing is idempotent.
 */
export async function installRuntime(options: InstallOptions): Promise<InstalledRuntime> {
  const target = options.target ?? runtimeTarget();
  const { storageRoot, version, log } = options;
  const finalRoot = versionRoot(storageRoot, version);
  const finalDir = runtimeDirFor(storageRoot, version, target);

  if (missingRuntimeFiles(finalDir).length === 0) return { version, dir: finalDir };

  mkdirSync(storageRoot, { recursive: true });
  const tempRoot = join(storageRoot, `.tmp-${version}-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    let installed = false;
    if (options.npm) {
      try {
        await npmInstall(options.npm, tempRoot, version);
        installed = missingRuntimeFiles(runtimeDirFor(tempRoot, '.', target)).length === 0;
        if (!installed) {
          // A registry mirror that skipped the optional platform dependency —
          // npm reports success regardless.
          log(`npm installed ${RUNTIME_PACKAGE}@${version} without ${platformPackage(target)}; downloading it directly`);
        }
      } catch (error) {
        log(`npm install failed — ${describe(error)}; downloading directly`);
      }
    }
    if (!installed) {
      rmSync(tempRoot, { recursive: true, force: true });
      await downloadPlatformPackage(options.registry, target, version, runtimeDirFor(tempRoot, '.', target), log);
    }

    const missing = missingRuntimeFiles(runtimeDirFor(tempRoot, '.', target));
    if (missing.length > 0) {
      throw new Error(`${platformPackage(target)}@${version} is incomplete (missing ${missing.join(', ')}).`);
    }

    try {
      renameSync(tempRoot, finalRoot);
    } catch (error) {
      // Another window finished the same version first; theirs is as good.
      if (missingRuntimeFiles(finalDir).length > 0) {
        rmSync(finalRoot, { recursive: true, force: true });
        renameSync(tempRoot, finalRoot);
      } else {
        log(`${version} was installed concurrently — ${describe(error)}`);
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  return { version, dir: finalDir };
}

async function npmInstall(npm: string, prefix: string, version: string): Promise<void> {
  mkdirSync(prefix, { recursive: true });
  // A package.json of our own stops npm from walking up and treating some
  // parent directory as the project.
  writeFileSync(
    join(prefix, 'package.json'),
    `${JSON.stringify({ name: 'codebrain-runtime', private: true }, null, 2)}\n`,
  );
  await runCommand(
    npm,
    [
      'install',
      `${RUNTIME_PACKAGE}@${version}`,
      '--prefix',
      prefix,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--omit=dev',
      '--loglevel=error',
    ],
    { cwd: prefix, timeoutMs: NPM_TIMEOUT_MS },
  );
}

/** Fetch the platform tarball, verify it, and unpack it into `destination`. */
async function downloadPlatformPackage(
  registry: string,
  target: string,
  version: string,
  destination: string,
  log: Log,
): Promise<void> {
  const name = platformPackage(target);
  const manifest = (await getJson(`${registry}${encodePackage(name)}/${version}`)) as {
    dist?: { tarball?: string; integrity?: string; shasum?: string };
  };
  const tarball = manifest.dist?.tarball;
  if (!tarball) throw new Error(`${name}@${version} has no tarball on ${registry}.`);

  mkdirSync(destination, { recursive: true });
  const archive = join(destination, '..', `${target}-${version}.tgz`);
  log(`downloading ${tarball}`);
  const digest = await downloadFile(tarball, archive);

  const expected = manifest.dist?.integrity;
  if (expected?.startsWith('sha512-')) {
    if (digest.sha512 !== expected.slice('sha512-'.length)) {
      throw new Error(`${name}@${version} failed its integrity check — the download is corrupt or was altered.`);
    }
  } else if (manifest.dist?.shasum && digest.sha1 !== manifest.dist.shasum) {
    throw new Error(`${name}@${version} failed its checksum — the download is corrupt or was altered.`);
  }

  // npm tarballs wrap everything in `package/`; the system tar keeps modes,
  // so the vendored `node` stays executable.
  await runCommand(systemTar(), ['-xzf', archive, '-C', destination, '--strip-components=1'], {
    timeoutMs: NPM_TIMEOUT_MS,
  });
  rmSync(archive, { force: true });
}

/**
 * Windows 10+ ships bsdtar in System32. Named explicitly because a Git for
 * Windows GNU `tar` earlier on PATH reads `C:\…` as a remote `host:path`.
 */
function systemTar(): string {
  if (process.platform !== 'win32') return 'tar';
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(system) ? system : 'tar';
}

// --------------------------------------------------------------------- http

function encodePackage(name: string): string {
  return name.replace('/', '%2f');
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function normalizeRegistry(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed && /^https?:\/\//.test(trimmed) ? withTrailingSlash(trimmed) : undefined;
}

function request(url: string, timeoutMs: number, redirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(
      url,
      { headers: { accept: 'application/json', 'user-agent': 'codebrain-vscode' }, timeout: timeoutMs },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects <= 0) return reject(new Error(`too many redirects fetching ${url}`));
          return resolve(request(new URL(response.headers.location, url).toString(), timeoutMs, redirects - 1));
        }
        if (status !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${status} fetching ${url}`));
        }
        resolve(response);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

async function getJson(url: string): Promise<unknown> {
  const response = await request(url, NETWORK_TIMEOUT_MS);
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function downloadFile(url: string, path: string): Promise<{ sha512: string; sha1: string }> {
  const response = await request(url, DOWNLOAD_TIMEOUT_MS);
  const sha512 = createHash('sha512');
  const sha1 = createHash('sha1');
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(path);
    response.on('data', (chunk: Buffer) => {
      sha512.update(chunk);
      sha1.update(chunk);
    });
    response.on('error', reject);
    file.on('error', reject);
    file.on('finish', resolve);
    response.pipe(file);
  });
  return { sha512: sha512.digest('base64'), sha1: sha1.digest('hex') };
}

// ------------------------------------------------------------------ process

function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  const shell = process.platform === 'win32' && command.endsWith('.cmd');
  return new Promise((resolve, reject) => {
    execFile(
      command,
      // With a shell, Node joins the arguments with bare spaces, so a storage
      // path under `C:\Users\First Last\` has to be quoted by hand.
      shell ? args.map((arg) => (/[\s&()^|<>]/.test(arg) ? `"${arg}"` : arg)) : [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        // npm.cmd is a batch shim, which Node refuses to spawn without a shell
        // on Windows (the CVE-2024-27980 hardening). Every argument here is
        // ours — a version string or a path we built — never user input.
        shell,
        env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ');
          reject(new Error(detail ? `${error.message.split('\n')[0]} — ${detail}` : error.message));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
