import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { runtimeTarget } from './runtimeInstaller';

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

/**
 * Where commands get their runtime from. The runtime is installed from npm
 * after activation and replaced by auto-update while the extension runs, so
 * callers ask for it per command instead of holding one fixed value.
 */
export interface CodeBrainRuntime {
  /** The runtime to use now; waits for the first install when there is none yet. */
  resolve(): Promise<RuntimeCommand>;
  /** The runtime in use, or `undefined` while the first install is still running. */
  current(): RuntimeCommand | undefined;
}

/**
 * The runtime right now, for writes that embed its path (agent MCP entries).
 * Callers await `resolve()` before any user-facing write, so reaching the
 * throw means a background repair ran before the first install finished.
 */
export function requireRuntime(runtime: CodeBrainRuntime): RuntimeCommand {
  const current = runtime.current();
  if (!current) throw new Error('the CodeGraph runtime is still being installed.');
  return current;
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

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore the execute bit on the installed runtime, and report what needed it.
 *
 * npm and the system `tar` both keep unix file modes, but not everything that
 * touches the install afterwards does: a copied or rsynced storage directory,
 * a restored backup, or a runtime unpacked on a filesystem mounted without
 * exec semantics can all leave `node` as a plain non-executable file. Every
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
      `The CodeGraph runtime in ${root} is not executable and could not be ` +
        `repaired automatically. Run: chmod +x ${unrepairable
          .map((path) => `"${path}"`)
          .join(' ')}`,
    );
  }

  return repaired;
}

/**
 * Describe the runtime installed in `root` — a directory holding `node`,
 * `lib/` and `bin/`, the layout of the `@xuansang2770/codegraph-<target>` npm
 * package — repairing its execute bits on the way.
 */
export function describeRuntime(root: string, target = runtimeTarget()): RuntimeCommand {
  const command = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  const entrypoint = join(root, 'lib', 'dist', 'bin', 'codegraph.js');

  if (!existsSync(command) || !existsSync(entrypoint)) {
    throw new Error(`The CodeGraph runtime in ${root} is incomplete.`);
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
 * lost it afterwards (a restored backup, a copied storage directory) — say which file and how to fix it instead of leaking errno.
 */
function describeSpawnFailure(error: unknown, command: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'EACCES' && code !== 'EPERM') return error;
  return new Error(
    `CodeBrain could not execute its CodeGraph runtime (${command}): permission denied. ` +
      `Run: chmod +x "${command}" — or run "CodeBrain: Reinstall CodeGraph Runtime".`,
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
  runtime: CodeBrainRuntime,
  args: readonly string[],
  options: RunOptions,
): Promise<ProcessResult> {
  const resolved = await runtime.resolve();
  return runProcess(resolved.command, [...resolved.baseArgs, ...args], options);
}

/**
 * The MCP tools every CodeBrain server lists. CodeGraph lists only
 * `codegraph_explore` by default; `codegraph_review` is added so an agent
 * asked to review a change can get the breaking-change and caller report in
 * one call instead of grepping for callers of every changed function.
 */
export const REVIEW_TOOL_SURFACE = 'explore,review';

export function codeBrainEnvironment(): Record<string, string> {
  const config = vscode.workspace.getConfiguration('codebrain');
  const autoRefresh = config.get<boolean>('autoRefresh.enabled', true);
  const debounceMs = config.get<number>('autoRefresh.debounceMs', 1000);
  const reviewTool = config.get<boolean>('mcp.reviewTool', true);

  return {
    ...(reviewTool ? { CODEGRAPH_MCP_TOOLS: REVIEW_TOOL_SURFACE } : {}),
    CODEGRAPH_WATCH_DEBOUNCE_MS: String(debounceMs),
    // The extension installs and updates the runtime itself. The server's own
    // "run `codegraph upgrade`" notice would send the agent after a CLI that
    // is not on its PATH.
    CODEGRAPH_NO_UPDATE_CHECK: '1',
    ...(autoRefresh ? {} : { CODEGRAPH_NO_WATCH: '1' }),
  };
}
