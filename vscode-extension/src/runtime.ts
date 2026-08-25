import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const MAX_PROCESS_OUTPUT = 2_000_000;

/**
 * Files in a POSIX runtime bundle that have to carry the execute bit: `node` is
 * what the extension spawns, and `bin/codegraph` is the launcher an agent or a
 * terminal may run directly.
 */
const POSIX_EXECUTABLES = ['node', join('bin', 'codegraph')];

export interface RuntimeCommand {
  command: string;
  baseArgs: string[];
  entrypoint: string;
  target: string;
  nativeKernel: boolean;
  /**
   * Runtime files whose execute bit was missing and has just been restored.
   * Empty on a healthy install; non-empty is worth logging, never an error.
   */
  repairedExecutables: string[];
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  token?: vscode.CancellationToken;
  maxOutputCharacters?: number;
  /**
   * Called with each stdout chunk as it arrives. Lets long-running commands
   * such as `init` report real progress instead of showing a static spinner.
   */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void;
}

function runtimeTarget(): string {
  if (
    (process.platform !== 'darwin' &&
      process.platform !== 'linux' &&
      process.platform !== 'win32') ||
    (process.arch !== 'x64' && process.arch !== 'arm64')
  ) {
    throw new Error(
      `CodeBrain does not include a runtime for ${process.platform}-${process.arch}.`,
    );
  }
  return `${process.platform}-${process.arch}`;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore the execute bit on the bundled runtime, and report what needed it.
 *
 * A `.vsix` records unix file modes, but not everything that unpacks one keeps
 * them: VS Code forks and OpenVSX-based hosts, installs done by unzipping the
 * archive by hand, a copied or rsynced extensions directory, and any package
 * built on Windows all land `node` as a plain non-executable file. Every
 * CodeBrain command then dies with `EACCES` and the user has to run `chmod +x`
 * themselves before the extension works at all. Doing it here means they never
 * have to — the repair is idempotent, so a healthy install pays one `access()`
 * per file and changes nothing.
 *
 * Read bits are mirrored into execute rather than forcing `0755`, so an install
 * someone deliberately kept private (`0600`) stays private.
 *
 * Throws only if a file is still not executable afterwards — nothing the
 * extension does can work at that point, so the message carries the exact
 * command that fixes it.
 */
export function ensureRuntimeExecutable(root: string): string[] {
  if (process.platform === 'win32') return [];

  const repaired: string[] = [];
  const unrepairable: string[] = [];

  for (const relative of POSIX_EXECUTABLES) {
    const target = join(root, relative);
    if (!existsSync(target) || isExecutable(target)) continue;

    try {
      const mode = statSync(target).mode & 0o777;
      chmodSync(target, mode | ((mode & 0o444) >> 2));
    } catch {
      // Fall through to the re-check below: a second window may have repaired
      // the file already, and only the end state decides whether we can run.
    }

    if (isExecutable(target)) repaired.push(target);
    else unrepairable.push(target);
  }

  if (unrepairable.length > 0) {
    throw new Error(
      `The bundled CodeBrain runtime for ${root} is not executable and could not be ` +
        `repaired automatically. Run: chmod +x ${unrepairable
          .map((path) => `"${path}"`)
          .join(' ')}`,
    );
  }

  return repaired;
}

export function locateRuntime(extensionUri: vscode.Uri): RuntimeCommand {
  const target = runtimeTarget();
  const root = join(extensionUri.fsPath, 'runtime', target);
  const command = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  const entrypoint = join(root, 'lib', 'dist', 'bin', 'codegraph.js');

  if (!existsSync(command) || !existsSync(entrypoint)) {
    throw new Error(
      `Bundled CodeBrain runtime is missing for ${target}. Reinstall the platform-specific extension package.`,
    );
  }

  const repairedExecutables = ensureRuntimeExecutable(root);

  return {
    command,
    baseArgs: [
      '--liftoff-only',
      '--disable-warning=ExperimentalWarning',
      entrypoint,
    ],
    entrypoint,
    target,
    nativeKernel: existsSync(
      join(root, 'lib', 'kernel', 'codegraph-kernel.node'),
    ),
    repairedExecutables,
  };
}

/**
 * Turn a bare `spawn ... EACCES` into something the user can act on. The
 * execute bit is repaired at activation, so reaching this means the runtime
 * lost it afterwards (an extension update that unpacked without modes, a
 * restored backup) — say which file and how to fix it instead of leaking errno.
 */
function describeSpawnFailure(error: unknown, command: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'EACCES' && code !== 'EPERM') return error;
  return new Error(
    `CodeBrain could not execute its bundled runtime (${command}): permission denied. ` +
      `Run: chmod +x "${command}" — or reinstall the extension.`,
    { cause: error },
  );
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<ProcessResult> {
  const maxOutput = options.maxOutputCharacters ?? MAX_PROCESS_OUTPUT;

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...options.env,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutput) {
        truncated = true;
        return current;
      }
      const remaining = maxOutput - current.length;
      const text = chunk.toString('utf8');
      if (text.length > remaining) {
        truncated = true;
        return current + text.slice(0, remaining);
      }
      return current + text;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      if (options.onStdout) {
        // Progress reporting must never be able to kill the child process.
        try {
          options.onStdout(chunk.toString('utf8'));
        } catch {
          // Ignore listener failures.
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      if (options.onStderr) {
        try {
          options.onStderr(chunk.toString('utf8'));
        } catch {
          // Ignore listener failures.
        }
      }
    });

    const cancellation = options.token?.onCancellationRequested(() => {
      child.kill();
    });

    child.once('error', (error) => {
      cancellation?.dispose();
      reject(describeSpawnFailure(error, command));
    });
    child.once('close', (code) => {
      cancellation?.dispose();
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

export async function runCodeBrain(
  runtime: RuntimeCommand,
  args: readonly string[],
  options: RunOptions,
): Promise<ProcessResult> {
  return runProcess(runtime.command, [...runtime.baseArgs, ...args], options);
}

export function codeBrainEnvironment(): Record<string, string> {
  const config = vscode.workspace.getConfiguration('codebrain');
  const autoRefresh = config.get<boolean>('autoRefresh.enabled', true);
  const debounceMs = config.get<number>('autoRefresh.debounceMs', 1000);

  return {
    CODEGRAPH_WATCH_DEBOUNCE_MS: String(debounceMs),
    ...(autoRefresh ? {} : { CODEGRAPH_NO_WATCH: '1' }),
  };
}
