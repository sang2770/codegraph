import { relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { BlastRadiusLensProvider } from './blastRadiusLens';
import { GraphCache } from './graphCache';
import { IndexFreshness } from './indexFreshness';
import {
  codeBrainEnvironment,
  CodeBrainRuntime,
  runCodeBrain,
  runProcess,
} from './runtime';
import { indexedRootForPath } from './workspace';

export interface SymbolCaller {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
}

export type SymbolLensMode = 'changedFiles' | 'allFiles' | 'off';

/** Symbols per file that get a lens; beyond this a file is generated or vendored. */
const MAX_SYMBOLS_PER_FILE = 80;
/** Concurrent `callers` lookups; resolve requests arrive for every visible lens at once. */
const MAX_CONCURRENT_LOOKUPS = 3;
/** How long a `git status` answer is reused while the developer scrolls and types. */
const CHANGED_FILES_TTL_MS = 5_000;
const CALLER_LIMIT = 200;

/**
 * The function and method names a lens should sit on, with their lines.
 *
 * Accepts both shapes a document-symbol provider may return: hierarchical
 * `DocumentSymbol`s and flat `SymbolInformation`s. Pure over plain objects so
 * the filtering is testable without a language server.
 */
export function collectLensSymbols(
  symbols: readonly unknown[],
  kinds: { function: number; method: number },
  limit = MAX_SYMBOLS_PER_FILE,
): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = [];
  const visit = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (found.length >= limit || !item || typeof item !== 'object') return;
      const symbol = item as {
        name?: unknown;
        kind?: unknown;
        selectionRange?: { start?: { line?: unknown } };
        range?: { start?: { line?: unknown } };
        location?: { range?: { start?: { line?: unknown } } };
        children?: unknown;
      };
      const line =
        symbol.selectionRange?.start?.line ??
        symbol.range?.start?.line ??
        symbol.location?.range?.start?.line;
      if (
        (symbol.kind === kinds.function || symbol.kind === kinds.method) &&
        typeof symbol.name === 'string' &&
        typeof line === 'number'
      ) {
        // Language servers decorate names: Java's `total(int)`, Go's
        // `(*Cart).Total`. The graph stores the bare identifier.
        const name = symbol.name
          .replace(/^\([^)]*\)\./, '')
          .replace(/\(.*$/s, '')
          .replace(/^.*[.:]/, '')
          .trim();
        if (/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) {
          found.push({ name, line });
        }
      }
      if (Array.isArray(symbol.children)) visit(symbol.children);
    }
  };
  visit(symbols);
  return found;
}

/** Parse `codegraph callers --json`; anything else (a "not found" notice) means no callers. */
export function parseCallers(stdout: string): SymbolCaller[] {
  try {
    const parsed = JSON.parse(stdout) as { callers?: unknown };
    if (!Array.isArray(parsed.callers)) return [];
    return parsed.callers.filter(
      (caller): caller is SymbolCaller =>
        !!caller &&
        typeof caller === 'object' &&
        typeof (caller as SymbolCaller).name === 'string' &&
        typeof (caller as SymbolCaller).filePath === 'string',
    );
  } catch {
    return [];
  }
}

/** Repository-relative paths from `git status --porcelain`. */
export function parsePorcelain(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      // Renames are `old -> new`; the lens belongs to the new path.
      const renamed = path.includes(' -> ') ? path.split(' -> ').pop()! : path;
      return renamed.replace(/^"|"$/g, '');
    });
}

class SymbolLens extends vscode.CodeLens {
  public constructor(
    range: vscode.Range,
    public readonly root: string,
    public readonly relativePath: string,
    public readonly symbol: string,
  ) {
    super(range);
  }
}

/**
 * `N callers | Run affected tests` above each function and method.
 *
 * The file-level blast-radius lens answers "how much depends on this file";
 * this one answers it for the function being edited. Caller counts are fetched
 * lazily in `resolveCodeLens`, which VS Code calls only for lenses on screen,
 * and by default only for files with uncommitted changes — the files where the
 * number can still change a decision.
 */
export class SymbolImpactLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly cache = new GraphCache<SymbolCaller[]>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changedFiles = new Map<string, { at: number; files: Promise<Set<string>> }>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public constructor(
    private readonly runtime: CodeBrainRuntime,
    private readonly freshness: IndexFreshness,
    private readonly fileLens: BlastRadiusLensProvider,
    private readonly log: (message: string) => void,
  ) {
    this.disposables.push(
      this.changeEmitter,
      freshness.onDidChangeProject(() => {
        this.changedFiles.clear();
        this.changeEmitter.fire();
      }),
      // The file-level lens learning a file's tests is what lets this one
      // offer "Run affected tests".
      fileLens.onDidChangeCodeLenses(() => this.changeEmitter.fire()),
      vscode.workspace.onDidSaveTextDocument(() => this.changedFiles.clear()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codebrain.codeLens')) {
          this.cache.clear();
          this.changeEmitter.fire();
        }
      }),
      vscode.commands.registerCommand('codebrain.showSymbolCallers', (args?: ShowCallersArgs) =>
        showSymbolCallers(args),
      ),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private mode(): SymbolLensMode {
    const config = vscode.workspace.getConfiguration('codebrain');
    if (!config.get<boolean>('codeLens.enabled', true)) return 'off';
    const mode = config.get<string>('codeLens.symbols', 'changedFiles');
    return mode === 'allFiles' || mode === 'off' ? mode : 'changedFiles';
  }

  private async isChanged(root: string, relativePath: string): Promise<boolean> {
    let entry = this.changedFiles.get(root);
    if (!entry || Date.now() - entry.at > CHANGED_FILES_TTL_MS) {
      const files = runProcess('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], {
        cwd: root,
        maxOutputCharacters: 200_000,
      })
        // Porcelain paths are relative to the repository root, which is above
        // the project root in a monorepo; the lookup below matches by suffix.
        .then((result) => new Set(result.code === 0 ? parsePorcelain(result.stdout) : []))
        .catch(() => new Set<string>());
      entry = { at: Date.now(), files };
      this.changedFiles.set(root, entry);
    }
    const files = await entry.files;
    if (files.has(relativePath)) return true;
    for (const file of files) {
      if (file.endsWith(`/${relativePath}`)) return true;
    }
    return false;
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const mode = this.mode();
    if (mode === 'off' || document.uri.scheme !== 'file') return [];
    const root = indexedRootForPath(document.uri.fsPath);
    if (!root) return [];
    const rootPath = resolve(root);
    const target = resolve(document.uri.fsPath);
    if (!target.startsWith(`${rootPath}${sep}`)) return [];
    const relativePath = relative(rootPath, target).replaceAll('\\', '/');
    if (relativePath.startsWith('.codegraph/')) return [];
    if (mode === 'changedFiles' && !(await this.isChanged(root, relativePath))) return [];

    let symbols: unknown[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<unknown[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
    } catch {
      return [];
    }
    if (!symbols?.length) return [];
    const tests = this.fileLens.cachedTests(root, relativePath);
    const lenses: vscode.CodeLens[] = [];
    for (const symbol of collectLensSymbols(symbols, {
      function: vscode.SymbolKind.Function,
      method: vscode.SymbolKind.Method,
    })) {
      const range = new vscode.Range(symbol.line, 0, symbol.line, 0);
      lenses.push(new SymbolLens(range, root, relativePath, symbol.name));
      if (tests && tests.length > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(play) Run ${tests.length} affected test${tests.length === 1 ? '' : 's'}`,
            tooltip: tests.slice(0, 10).join('\n'),
            command: 'codebrain.runAffectedTests',
            arguments: [{ root, tests }],
          }),
        );
      }
    }
    return lenses;
  }

  public async resolveCodeLens(
    lens: vscode.CodeLens,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens> {
    if (!(lens instanceof SymbolLens)) return lens;
    const callers = await this.callers(lens.root, lens.symbol, token);
    if (!callers) {
      lens.command = { title: '$(type-hierarchy-sub) callers unavailable', command: '' };
      return lens;
    }
    const count = callers.length >= CALLER_LIMIT ? `${CALLER_LIMIT}+` : String(callers.length);
    const files = new Set(callers.map((caller) => caller.filePath)).size;
    lens.command = {
      title:
        callers.length === 0
          ? '$(type-hierarchy-sub) no indexed callers'
          : `$(type-hierarchy-sub) ${count} caller${callers.length === 1 ? '' : 's'}${files > 1 ? ` in ${files} files` : ''}`,
      tooltip: `Indexed callers of functions named ${lens.symbol}. Click to see them or analyze change impact.`,
      command: 'codebrain.showSymbolCallers',
      arguments: [{ root: lens.root, symbol: lens.symbol, callers } satisfies ShowCallersArgs],
    };
    return lens;
  }

  private async acquire(): Promise<() => void> {
    if (this.active >= MAX_CONCURRENT_LOOKUPS) {
      await new Promise<void>((resolveWait) => this.waiting.push(resolveWait));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }

  private async callers(
    root: string,
    symbol: string,
    token: vscode.CancellationToken,
  ): Promise<SymbolCaller[] | undefined> {
    const key = { root, kind: 'callers', parts: [symbol] };
    const generation = this.freshness.generation(root);
    const cached = this.cache.get(key, generation);
    if (cached) return cached;
    const release = await this.acquire();
    try {
      if (token.isCancellationRequested) return undefined;
      const result = await runCodeBrain(
        this.runtime,
        ['callers', symbol, '--path', root, '--limit', String(CALLER_LIMIT), '--json'],
        { cwd: root, env: codeBrainEnvironment(), token },
      );
      if (result.code !== 0) {
        this.log(`[codelens] callers of ${symbol} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
        return undefined;
      }
      const callers = parseCallers(result.stdout);
      this.cache.set(key, generation, callers);
      return callers;
    } catch (error) {
      this.log(`[codelens] callers of ${symbol} threw: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      release();
    }
  }
}

interface ShowCallersArgs {
  root: string;
  symbol: string;
  callers: SymbolCaller[];
}

async function showSymbolCallers(args: ShowCallersArgs | undefined): Promise<void> {
  if (!args) return;
  const analyze = { label: '$(zap) Analyze change impact', description: 'Dependents, affected tests, and risk', caller: undefined };
  const picked = await vscode.window.showQuickPick(
    [
      analyze,
      ...args.callers.map((caller) => ({
        label: `$(symbol-${caller.kind === 'method' ? 'method' : 'function'}) ${caller.name}`,
        description: `${caller.filePath}${caller.startLine ? `:${caller.startLine}` : ''}`,
        caller,
      })),
    ],
    {
      title: `CodeBrain: callers of ${args.symbol} (${args.callers.length})`,
      placeHolder: 'Open a caller, or analyze the impact of your change',
      matchOnDescription: true,
    },
  );
  if (!picked) return;
  if (!picked.caller) {
    await vscode.commands.executeCommand('codebrain.analyzeImpact');
    return;
  }
  const uri = vscode.Uri.file(resolve(args.root, picked.caller.filePath));
  const line = Math.max(0, (picked.caller.startLine ?? 1) - 1);
  await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0) });
}
