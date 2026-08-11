import { relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { GraphCache } from './graphCache';
import { IndexFreshness } from './indexFreshness';
import {
  codeBrainEnvironment,
  runCodeBrain,
  RuntimeCommand,
} from './runtime';
import { hasIndex, indexedRootForPath } from './workspace';

export interface FileBlastRadius {
  dependents: number;
  directDependents: number;
  tests: number;
  testPaths: string[];
}

/** Quiet period before a changed file's lens is recomputed. */
const DEBOUNCE_MS = 600;

function relativeToRoot(root: string, filePath: string): string | undefined {
  const rootPath = resolve(root);
  const target = resolve(filePath);
  if (target === rootPath || !target.startsWith(`${rootPath}${sep}`)) {
    return undefined;
  }
  return relative(rootPath, target).replaceAll('\\', '/');
}

/**
 * Shows a file's blast radius as a CodeLens above line 1.
 *
 * Every other CodeBrain surface waits to be asked. That means the information
 * developers most need while editing — "how much depends on this?" — only
 * arrives if they remember a command exists. A lens puts it where the edit is
 * happening, which is the only place it can change a decision.
 */
export class BlastRadiusLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly cache = new GraphCache<FileBlastRadius>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /**
   * Keys whose computation failed. Without this a failure leaves the lens
   * showing “measuring…” forever, because nothing would ever fire a change to
   * re-render it.
   */
  private readonly failed = new Set<string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private debounce?: ReturnType<typeof setTimeout>;

  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public constructor(
    private readonly runtime: RuntimeCommand,
    private readonly freshness: IndexFreshness,
    private readonly log: (message: string) => void,
  ) {
    this.disposables.push(
      this.changeEmitter,
      freshness.onDidChangeProject(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('codebrain.codeLens.enabled') ||
          event.affectsConfiguration('codebrain.impact.maxDepth')
        ) {
          this.cache.clear();
          this.failed.clear();
          this.changeEmitter.fire();
        }
      }),
    );
  }

  public dispose(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private markFailed(id: string): void {
    this.failed.add(id);
    this.changeEmitter.fire();
  }

  private scheduleRefresh(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      // A new generation deserves a fresh attempt.
      this.failed.clear();
      this.changeEmitter.fire();
    }, DEBOUNCE_MS);
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    const enabled = vscode.workspace
      .getConfiguration('codebrain')
      .get<boolean>('codeLens.enabled', true);
    if (!enabled || document.uri.scheme !== 'file' || document.lineCount === 0) {
      return [];
    }
    const root = indexedRootForPath(document.uri.fsPath);
    if (!root) {
      return [];
    }
    const relativePath = relativeToRoot(root, document.uri.fsPath);
    if (!relativePath || relativePath.startsWith('.codegraph/')) {
      return [];
    }

    const depth = vscode.workspace
      .getConfiguration('codebrain')
      .get<number>('impact.maxDepth', 5);
    const key = { root, kind: 'blast', parts: [relativePath, depth] };
    const generation = this.freshness.generation(root);
    const cached = this.cache.get(key, generation);
    const range = new vscode.Range(0, 0, 0, 0);
    const id = `${root}\0${relativePath}\0${depth}\0${generation}`;

    if (!cached && this.failed.has(id)) {
      // Already tried and failed at this generation; show nothing rather than a
      // spinner that will never resolve.
      return [];
    }
    if (!cached) {
      // Compute off the critical path so opening a file is never blocked on a
      // subprocess; the lens re-renders when the result arrives.
      void this.compute(root, relativePath, depth, generation, id, token);
      return [
        new vscode.CodeLens(range, {
          title: '$(loading~spin) CodeBrain: measuring blast radius…',
          command: '',
        }),
      ];
    }

    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(range, {
        title:
          cached.dependents === 0 && cached.tests === 0
            ? '$(zap) CodeBrain: no indexed dependents'
            : `$(zap) CodeBrain: ${cached.dependents} dependent${cached.dependents === 1 ? '' : 's'} · ${cached.tests} affected test${cached.tests === 1 ? '' : 's'}`,
        tooltip:
          `${cached.directDependents} file(s) import this one directly; ` +
          `${cached.dependents} depend on it within ${depth} level(s). ` +
          'Click to run a full change-impact analysis.',
        command: 'codebrain.analyzeImpact',
      }),
    ];
    if (cached.tests > 0) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(beaker) Run ${cached.tests} affected test${cached.tests === 1 ? '' : 's'}`,
          tooltip: cached.testPaths.slice(0, 10).join('\n'),
          command: 'codebrain.runAffectedTests',
          arguments: [{ root, tests: cached.testPaths }],
        }),
      );
    }
    return lenses;
  }

  private async compute(
    root: string,
    relativePath: string,
    depth: number,
    generation: number,
    id: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (this.inFlight.has(id)) {
      return this.inFlight.get(id);
    }
    const work = (async () => {
      const folder = { uri: vscode.Uri.file(root) } as vscode.WorkspaceFolder;
      if (!hasIndex(folder)) {
        this.markFailed(id);
        return;
      }
      const result = await runCodeBrain(
        this.runtime,
        [
          'affected',
          relativePath,
          '--path',
          root,
          '--depth',
          String(depth),
          '--json',
        ],
        { cwd: root, env: codeBrainEnvironment(), token },
      );
      if (token.isCancellationRequested) {
        // Superseded by a newer request, not a failure. Leave the key clean so
        // the next provideCodeLenses tries again.
        return;
      }
      if (result.code !== 0) {
        // A lens is decoration: log the failure, but never surface an error
        // popup for it or the editor becomes hostile while typing.
        this.log(
          `[codelens] blast radius for ${relativePath} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
        );
        this.markFailed(id);
        return;
      }
      let parsed: {
        dependentFiles?: unknown;
        affectedTests?: unknown;
        directDependents?: unknown;
        totalDependentsTraversed?: unknown;
      };
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        this.log(`[codelens] blast radius for ${relativePath} returned unparseable JSON.`);
        this.markFailed(id);
        return;
      }
      const testPaths = Array.isArray(parsed.affectedTests)
        ? parsed.affectedTests.filter((item): item is string => typeof item === 'string')
        : [];
      const dependentFiles = Array.isArray(parsed.dependentFiles)
        ? parsed.dependentFiles.filter((item): item is string => typeof item === 'string')
        : [];
      this.cache.set({ root, kind: 'blast', parts: [relativePath, depth] }, generation, {
        dependents:
          dependentFiles.length ||
          (typeof parsed.totalDependentsTraversed === 'number'
            ? parsed.totalDependentsTraversed
            : 0),
        directDependents:
          typeof parsed.directDependents === 'number' ? parsed.directDependents : 0,
        tests: testPaths.length,
        testPaths,
      });
      this.changeEmitter.fire();
    })().catch((error: unknown) => {
      this.log(
        `[codelens] blast radius for ${relativePath} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.markFailed(id);
    });
    this.inFlight.set(id, work);
    try {
      await work;
    } finally {
      this.inFlight.delete(id);
    }
  }
}
