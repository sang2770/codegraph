import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const MAX_PROCESS_OUTPUT = 2_000_000;

export interface RuntimeCommand {
  command: string;
  baseArgs: string[];
  entrypoint: string;
  target: string;
  nativeKernel: boolean;
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
  };
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
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const cancellation = options.token?.onCancellationRequested(() => {
      child.kill();
    });

    child.once('error', (error) => {
      cancellation?.dispose();
      reject(error);
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
