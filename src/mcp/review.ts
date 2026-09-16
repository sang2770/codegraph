/**
 * Diff-aware review context — the engine behind the `codegraph_review` MCP tool.
 *
 * WHY THIS EXISTS (and why it is NOT just `codegraph_explore` with a diff):
 * a third-party reviewer (a review bot, another agent, a CI step) already HAS
 * the diff. What it does not have — and what it otherwise reconstructs with a
 * long Read/Grep loop — is everything the diff cannot show:
 *
 *   1. which SYMBOLS the changed lines actually live in,
 *   2. who CALLS those symbols from files that are NOT in the diff,
 *   3. what BREAKS: signatures that changed / exports that vanished while
 *      call sites outside the diff stayed put,
 *   4. which TESTS cover the blast radius, and which changed symbols nothing
 *      covers at all.
 *
 * All four are pre-computed in the graph, so this is a single round-trip over
 * SQLite instead of an agent reading N files.
 *
 * TOKEN BUDGET is a first-class design constraint. The reviewer already holds
 * the source of the changed lines, so by default we emit **no source at all** —
 * only structure: `file:line`, signatures, call sites, severities. Source is
 * opt-in per scope via {@link ReviewOptions.includeSource}, and the whole
 * report is hard-capped by `maxChars`. The cheapest useful call is the default
 * one.
 *
 * Determinism: every finding here is derived from the AST + the graph (and, for
 * breaking changes, from re-parsing the pre-change blob out of git). Nothing is
 * LLM-summarized — consistent with the rest of CodeGraph's extraction.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve as pathResolve } from 'path';
import type CodeGraph from '../index';
import type { Edge, Node, NodeKind } from '../types';
import { isTestFile } from '../search/query-utils';
import { gitWorktreeRoot } from '../sync/worktree';
import { initGrammars, loadGrammarsForLanguages, detectLanguage } from '../extraction/grammars';

// ---------------------------------------------------------------------------
// Public options / result shapes
// ---------------------------------------------------------------------------

/** How much verbatim source the report is allowed to carry. */
export type IncludeSource = 'none' | 'changed' | 'callers' | 'all';

export interface ReviewOptions {
  /** Git ref the change is measured against (e.g. `origin/main`, `HEAD~1`). */
  base?: string;
  /** Git ref for the changed side. Defaults to the working tree. */
  head?: string;
  /** Explicit changed-file list — use when the caller has no local git. */
  files?: string[];
  /** Raw unified diff — use when the caller already fetched the PR diff. */
  diff?: string;
  /** Verbatim source scope (default `none` — the reviewer already has the diff). */
  includeSource?: IncludeSource;
  /** Hard cap on report size (default 24000). */
  maxChars?: number;
  /** Max call sites listed per changed symbol (default 8). */
  maxCallers?: number;
  /** Max changed symbols analyzed in depth (default 60). */
  maxSymbols?: number;
  /** `markdown` (default, densest) or `json` for programmatic consumers. */
  format?: 'markdown' | 'json';
}

export type Severity = 'high' | 'medium' | 'low';

export type FindingKind =
  | 'breaking-signature'
  | 'removed-symbol'
  | 'unreviewed-callers'
  | 'missing-test'
  | 'wide-blast-radius'
  | 'public-surface-change'
  | 'new-symbol-no-callers';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** `Class.method` or the bare name. */
  symbol: string;
  file: string;
  line?: number;
  /** One sentence, already written for a reviewer to act on. */
  message: string;
  /** Concrete `file:line symbol` sites backing the claim. */
  evidence: string[];
}

/** A symbol that existed at `base` and no longer exists in the working tree. */
export interface RemovedSymbol {
  file: string;
  name: string;
  signature?: string;
  /**
   * `file:line` sites that still reference the name and now resolve to nothing
   * — the precise evidence that the removal broke a caller.
   */
  danglingSites: string[];
  /** Weaker fallback: files importing the module the symbol lived in. */
  importers: string[];
}

export interface ChangedSymbol {
  node: Node;
  /** Call sites, deduped by caller node. */
  callers: Array<{ node: Node; edge: Edge }>;
  /** Callers living in files the diff does NOT touch. */
  externalCallers: Array<{ node: Node; edge: Edge }>;
  /** Transitive dependent count (blast radius, depth 2). */
  blastRadius: number;
  /** Test files reachable from this symbol's dependents. */
  coveringTests: string[];
  /** `added` when the symbol did not exist at `base`. */
  isNew: boolean;
  /** Pre-change signature when it differs from the current one. */
  oldSignature?: string;
}

export interface ReviewReport {
  base: string | null;
  head: string | null;
  changedFiles: ChangedFile[];
  symbols: ChangedSymbol[];
  findings: Finding[];
  /** Files outside the diff that depend on changed code. */
  rippleFiles: Array<{ path: string; callSites: number }>;
  affectedTests: string[];
  /** Why a section is missing/degraded (no git, unindexed files, caps hit). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Diff acquisition + parsing
// ---------------------------------------------------------------------------

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface LineRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  /** Project-relative, forward-slash path on the NEW side. */
  path: string;
  /** Previous path for a rename/delete. */
  oldPath?: string;
  status: ChangeStatus;
  /** Touched line ranges on the new side; empty when only a file list was given. */
  ranges: LineRange[];
  /** False when the caller passed bare file names (no hunks to narrow by). */
  hasLineInfo: boolean;
}

/**
 * Refs reach `git` as argv (never a shell), but a ref that begins with `-` would
 * still be read as an OPTION by git itself — `--upload-pack=...` and friends.
 * Allow only the characters real refs use, and never a leading dash.
 */
const SAFE_REF = /^[A-Za-z0-9._/~^{}@-]{1,200}$/;

/** Whether a caller-supplied ref is safe to hand to `git` as argv. */
export function isSafeRef(ref: string): boolean {
  return !ref.startsWith('-') && SAFE_REF.test(ref);
}

function assertSafeRef(ref: string, label: string): string {
  if (ref.startsWith('-') || !SAFE_REF.test(ref)) {
    throw new Error(`Invalid ${label} git ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * Ask git for the diff. `base` + `head` uses three-dot (merge-base) range —
 * the PR semantic: what this branch adds, not what `base` moved on to. `base`
 * alone diffs the working tree against it; neither means "uncommitted work".
 */
export function gitDiff(cwd: string, base?: string, head?: string): string | null {
  const args = ['diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=0'];
  if (base && head) {
    args.push(`${assertSafeRef(base, 'base')}...${assertSafeRef(head, 'head')}`);
  } else if (base) {
    args.push(assertSafeRef(base, 'base'));
  } else {
    // Uncommitted work: staged + unstaged, in one diff.
    args.push('HEAD');
  }
  return runGit(cwd, args);
}

/** The pre-change blob, used to diff signatures. Null when git/ref/path is unknown. */
export function gitShowFile(cwd: string, ref: string, filePath: string): string | null {
  return runGit(cwd, ['show', `${assertSafeRef(ref, 'base')}:${filePath}`]);
}

/**
 * Parse a unified diff into per-file NEW-side line ranges.
 *
 * Tolerant by design: the caller may hand us a `-U0` diff we produced, or a
 * default `-U3` diff pasted from a PR API (whose hunks include context lines,
 * so symbol mapping over-captures slightly rather than missing anything).
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;

  const push = () => {
    if (current && current.path) files.push(current);
  };

  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      push();
      // `diff --git a/old b/new` — paths may contain spaces, so prefer the
      // ---/+++ headers below and treat this only as a record boundary.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(rawLine);
      current = {
        path: m?.[2] ?? '',
        oldPath: m?.[1],
        status: 'modified',
        ranges: [],
        hasLineInfo: true,
      };
      continue;
    }
    if (!current) continue;

    if (rawLine.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (rawLine.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (rawLine.startsWith('rename from ')) {
      current.oldPath = rawLine.slice('rename from '.length).trim();
      current.status = 'renamed';
      continue;
    }
    if (rawLine.startsWith('rename to ')) {
      current.path = rawLine.slice('rename to '.length).trim();
      current.status = 'renamed';
      continue;
    }
    if (rawLine.startsWith('--- ')) {
      const p = rawLine.slice(4).trim();
      if (p !== '/dev/null') current.oldPath = stripDiffPrefix(p);
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      const p = rawLine.slice(4).trim();
      if (p === '/dev/null') current.status = 'deleted';
      else current.path = stripDiffPrefix(p);
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
      if (m) {
        const start = parseInt(m[1] as string, 10);
        const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
        // count === 0 is a pure deletion: nothing exists on the new side, but
        // the surrounding symbol is still what changed — anchor at `start`.
        const from = Math.max(1, count === 0 ? start : start);
        const to = Math.max(from, start + Math.max(count, 1) - 1);
        current.ranges.push({ start: from, end: to });
      }
      continue;
    }
  }
  push();

  // A deleted file's new-side path is meaningless; key it by the old path so
  // the report names the file that disappeared.
  for (const f of files) {
    if (f.status === 'deleted' && f.oldPath) f.path = f.oldPath;
  }
  return files.filter(f => f.path);
}

function stripDiffPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

/**
 * Normalize any caller-supplied path to the project-relative, forward-slash
 * form the index stores. Absolute paths, `./` prefixes, Windows separators and
 * paths relative to the git toplevel (when the index root is a sub-directory)
 * all have to land on the same string or they silently match zero nodes (#825).
 */
export function normalizeIndexPath(input: string, projectRoot: string, gitRoot?: string | null): string {
  let p = input.trim().replace(/\\/g, '/');
  if (!p) return '';
  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (p.startsWith(root + '/')) return p.slice(root.length + 1);
  if (gitRoot) {
    const gr = gitRoot.replace(/\\/g, '/').replace(/\/$/, '');
    // git reports paths relative to the toplevel; re-base onto the index root.
    if (root.startsWith(gr + '/')) {
      const prefix = root.slice(gr.length + 1) + '/';
      if (p.startsWith(prefix)) return p.slice(prefix.length);
    }
    if (p.startsWith(gr + '/')) return p.slice(gr.length + 1);
  }
  return p.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Synthesized-edge labelling (dynamic dispatch)
// ---------------------------------------------------------------------------

/**
 * Short label for a synthesized (dynamic-dispatch) call site, so a reviewer can
 * tell "grep would never have found this" from an ordinary static call. Mirrors
 * `ToolHandler.synthEdgeNote`'s compact form, with a generic fallback so a new
 * synthesizer still reads sensibly here without a second edit.
 */
export function synthLabel(edge: Edge | undefined): string | null {
  if (!edge || edge.provenance !== 'heuristic') return null;
  const m = (edge.metadata ?? {}) as Record<string, unknown>;
  const by = typeof m.synthesizedBy === 'string' ? m.synthesizedBy : null;
  if (!by) return 'dynamic';
  const at = typeof m.registeredAt === 'string' ? ` @${m.registeredAt}` : '';
  const via = typeof m.via === 'string' ? m.via : null;
  switch (by) {
    case 'callback': return `dynamic: callback via ${via ?? 'a registrar'}${at}`;
    case 'event-emitter': return `dynamic: event ${typeof m.event === 'string' ? m.event : '?'}${at}`;
    case 'react-render': return `dynamic: React re-render via setState${at}`;
    case 'jsx-render': return `dynamic: renders <${via ?? 'child'}>`;
    case 'vue-handler': return `dynamic: Vue ${typeof m.event === 'string' ? '@' + m.event : 'template'} handler`;
    case 'interface-impl': return `dynamic: interface → impl${at}`;
    default: return `dynamic: ${by}${at}`;
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Node kinds that can meaningfully "be changed" by a diff hunk. */
const REVIEWABLE_KINDS = new Set<NodeKind>([
  'function', 'method', 'class', 'struct', 'interface', 'trait', 'protocol',
  'enum', 'type_alias', 'route', 'component', 'constant', 'property', 'field', 'variable',
]);

/**
 * Kinds that can be a real call SITE. Containers (`file`, `module`) and the
 * import/export bookkeeping nodes reach a symbol through `contains`/`imports`
 * edges, so they surface as "callers" without being code that calls anything.
 */
const CALLER_KINDS = new Set<NodeKind>([
  'function', 'method', 'class', 'struct', 'interface', 'trait', 'protocol',
  'enum', 'type_alias', 'route', 'component', 'constant', 'property', 'field', 'variable',
  'namespace',
]);

/** Kinds whose change is a public-surface change worth flagging on its own. */
const SURFACE_KINDS = new Set<NodeKind>(['route', 'interface', 'protocol', 'trait']);

const DEFAULTS = {
  maxChars: 24000,
  maxCallers: 8,
  maxSymbols: 60,
  blastRadiusDepth: 2,
  wideBlastRadius: 12,
};

/**
 * The innermost reviewable symbols a hunk lands in. A hunk inside a method also
 * sits inside its class and its file; reporting all three buries the signal, so
 * for each changed range we keep only the SMALLEST containing symbol (plus any
 * symbol fully inside the range, which is the "whole function added" case).
 */
function selectChangedNodes(nodes: Node[], file: ChangedFile): Node[] {
  const candidates = nodes.filter(n => REVIEWABLE_KINDS.has(n.kind));
  if (!file.hasLineInfo || file.ranges.length === 0) {
    // No hunks: fall back to the file's top-level symbols, which is the most
    // useful summary a bare file list can support.
    return candidates.filter(n => !candidates.some(o => o !== n && contains(o, n)));
  }
  const picked = new Map<string, Node>();
  for (const range of file.ranges) {
    const hits = candidates.filter(n => n.startLine <= range.end && n.endLine >= range.start);
    if (hits.length === 0) continue;
    // Symbols entirely within the hunk were added/rewritten wholesale — keep all.
    const inside = hits.filter(n => n.startLine >= range.start && n.endLine <= range.end);
    if (inside.length > 0) {
      for (const n of inside) picked.set(n.id, n);
      continue;
    }
    let innermost: Node = hits[0] as Node;
    for (const n of hits) {
      if (n.endLine - n.startLine < innermost.endLine - innermost.startLine) innermost = n;
    }
    picked.set(innermost.id, innermost);
  }
  return [...picked.values()];
}

function contains(outer: Node, inner: Node): boolean {
  return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

function normalizeSignature(sig: string | undefined): string {
  return (sig ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Build the full review report. Pure analysis — rendering lives in
 * {@link renderReviewMarkdown}, so the JSON consumer and the markdown consumer
 * are guaranteed to be looking at the same findings.
 */
export async function analyzeReview(cg: CodeGraph, opts: ReviewOptions = {}): Promise<ReviewReport> {
  const projectRoot = cg.getProjectRoot();
  const gitRoot = gitWorktreeRoot(projectRoot);
  const notes: string[] = [];
  const maxCallers = Math.max(1, opts.maxCallers ?? DEFAULTS.maxCallers);
  const maxSymbols = Math.max(1, opts.maxSymbols ?? DEFAULTS.maxSymbols);

  // --- 1. Where does the change set come from? ------------------------------
  let changedFiles: ChangedFile[];
  if (opts.diff && opts.diff.trim()) {
    changedFiles = parseUnifiedDiff(opts.diff);
  } else if (opts.files && opts.files.length > 0) {
    changedFiles = opts.files.map(f => ({
      path: f,
      status: 'modified' as ChangeStatus,
      ranges: [],
      hasLineInfo: false,
    }));
    notes.push(
      'A bare file list was supplied, so symbols are reported per FILE, not per hunk. ' +
      'Pass `diff` (a unified diff) or a `base` ref to narrow findings to the changed lines.'
    );
  } else {
    const cwd = gitRoot ?? projectRoot;
    const raw = gitDiff(cwd, opts.base, opts.head);
    if (raw === null) {
      notes.push(
        'git produced no diff here (not a git worktree, or the base ref does not exist). ' +
        'Pass `files` (changed paths) or `diff` (a unified diff) instead.'
      );
      changedFiles = [];
    } else {
      changedFiles = parseUnifiedDiff(raw);
    }
  }

  // Normalize every path into the index's own relative form.
  for (const f of changedFiles) {
    f.path = normalizeIndexPath(f.path, projectRoot, gitRoot);
    if (f.oldPath) f.oldPath = normalizeIndexPath(f.oldPath, projectRoot, gitRoot);
  }
  changedFiles = changedFiles.filter(f => f.path);

  const changedPaths = new Set(changedFiles.map(f => f.path));

  // --- 2. Changed lines → changed symbols -----------------------------------
  const symbols: ChangedSymbol[] = [];
  let unindexed = 0;
  let truncatedSymbols = 0;

  for (const file of changedFiles) {
    if (file.status === 'deleted') continue;
    const nodes = cg.getNodesInFile(file.path);
    if (nodes.length === 0) {
      unindexed++;
      continue;
    }
    for (const node of selectChangedNodes(nodes, file)) {
      if (symbols.length >= maxSymbols) {
        truncatedSymbols++;
        continue;
      }
      symbols.push(buildChangedSymbol(cg, node, changedPaths, maxCallers));
    }
  }

  if (unindexed > 0) {
    notes.push(
      `${unindexed} changed file(s) have no symbols in the index (new file not yet synced, ` +
      'an unsupported language, or a non-code file) — review those from the diff directly.'
    );
  }
  if (truncatedSymbols > 0) {
    notes.push(`${truncatedSymbols} further changed symbol(s) omitted (maxSymbols=${maxSymbols}).`);
  }

  // --- 3. Pre-change comparison (breaking changes) --------------------------
  const removed: RemovedSymbol[] = [];
  if (opts.base && gitRoot) {
    // Re-parsing the pre-change blob needs this process's grammars, and an MCP
    // server is query-only: it opens the DB but never parses, so nothing has
    // loaded them. Without this the comparison silently found zero symbols and
    // the report claimed the base ref was unreadable — the breaking-change
    // section, the whole point of passing `base`, quietly went missing.
    const languages = [...new Set(
      changedFiles.filter(f => f.status !== 'deleted').map(f => detectLanguage(f.path)),
    )].filter(l => l !== 'unknown');
    let grammarsReady = true;
    try {
      await initGrammars();
      if (languages.length > 0) await loadGrammarsForLanguages(languages);
    } catch (err) {
      grammarsReady = false;
      notes.push(
        'Breaking-change detection was skipped: the parser for the changed files could not be ' +
        `loaded (${err instanceof Error ? err.message : String(err)}).`
      );
    }
    if (grammarsReady) {
      applyBaselineComparison(cg, opts.base, gitRoot, projectRoot, changedFiles, symbols, removed, notes);
    }
  } else if (!opts.base) {
    notes.push(
      'No `base` ref was given, so signature/removal comparison against the pre-change code was skipped. ' +
      'Pass `base` (e.g. "origin/main") to enable breaking-change detection.'
    );
  }

  // --- 4. Findings ----------------------------------------------------------
  const findings = buildFindings(symbols, removed);

  // --- 5. Ripple + tests ----------------------------------------------------
  const rippleCounts = new Map<string, number>();
  for (const sym of symbols) {
    for (const c of sym.externalCallers) {
      rippleCounts.set(c.node.filePath, (rippleCounts.get(c.node.filePath) ?? 0) + 1);
    }
  }
  // File-level dependents catch ripple the call graph misses (re-exports,
  // type-only imports), which is exactly the "not in the diff but breaks" case.
  for (const path of changedPaths) {
    for (const dep of cg.getFileDependents(path)) {
      if (changedPaths.has(dep)) continue;
      if (!rippleCounts.has(dep)) rippleCounts.set(dep, 0);
    }
  }
  const rippleFiles = [...rippleCounts.entries()]
    .filter(([p]) => !isTestFile(p))
    .map(([path, callSites]) => ({ path, callSites }))
    .sort((a, b) => b.callSites - a.callSites || a.path.localeCompare(b.path));

  const affectedTests = new Set<string>();
  for (const p of changedPaths) if (isTestFile(p)) affectedTests.add(p);
  for (const p of rippleCounts.keys()) if (isTestFile(p)) affectedTests.add(p);
  for (const sym of symbols) for (const t of sym.coveringTests) affectedTests.add(t);

  return {
    base: opts.base ?? null,
    head: opts.head ?? null,
    changedFiles,
    symbols,
    findings,
    rippleFiles,
    affectedTests: [...affectedTests].sort(),
    notes,
  };
}

function buildChangedSymbol(
  cg: CodeGraph,
  node: Node,
  changedPaths: Set<string>,
  maxCallers: number,
): ChangedSymbol {
  const seen = new Set<string>();
  const callers: Array<{ node: Node; edge: Edge }> = [];
  for (const c of cg.getCallers(node.id, 1)) {
    if (c.node.id === node.id || seen.has(c.node.id)) continue;
    // A file/import node is a container, not a call site: listing
    // "src/api.ts:1 src/api.ts" next to the real "src/api.ts:4 handleLogin"
    // is duplicate noise a reviewer pays tokens for and has to skip past.
    if (!CALLER_KINDS.has(c.node.kind)) continue;
    seen.add(c.node.id);
    callers.push(c);
  }
  // Callers inside the diff were reviewed alongside the change; the ones
  // outside it are the reason this tool exists, so they sort first.
  const externalCallers = callers.filter(c => !changedPaths.has(c.node.filePath));
  callers.sort((a, b) => {
    const ax = changedPaths.has(a.node.filePath) ? 1 : 0;
    const bx = changedPaths.has(b.node.filePath) ? 1 : 0;
    return ax - bx;
  });

  let blastRadius = 0;
  const coveringTests = new Set<string>();
  try {
    const radius = cg.getImpactRadius(node.id, DEFAULTS.blastRadiusDepth);
    for (const n of radius.nodes.values()) {
      if (n.id === node.id) continue;
      // Count real dependents only — counting the file node that contains a
      // caller double-counts it and inflates every severity threshold.
      if (CALLER_KINDS.has(n.kind)) blastRadius++;
      if (isTestFile(n.filePath)) coveringTests.add(n.filePath);
    }
  } catch {
    // A traversal failure must not sink the whole report — the symbol is still
    // worth reporting with its direct callers.
    blastRadius = callers.length;
  }
  for (const c of callers) if (isTestFile(c.node.filePath)) coveringTests.add(c.node.filePath);

  return {
    node,
    callers: callers.slice(0, maxCallers),
    externalCallers,
    blastRadius,
    coveringTests: [...coveringTests].sort(),
    isNew: false,
  };
}

/**
 * Re-parse each changed file as it existed at `base` and compare symbol-for-
 * symbol. This is the only part of the report that needs git: the index holds
 * the CURRENT tree only, so "what did this signature used to be" and "what
 * disappeared" cannot be answered from the graph alone.
 */
function applyBaselineComparison(
  cg: CodeGraph,
  base: string,
  gitRoot: string,
  projectRoot: string,
  changedFiles: ChangedFile[],
  symbols: ChangedSymbol[],
  removed: RemovedSymbol[],
  notes: string[],
): void {
  const byFile = new Map<string, ChangedSymbol[]>();
  for (const s of symbols) {
    const list = byFile.get(s.node.filePath) ?? [];
    list.push(s);
    byFile.set(s.node.filePath, list);
  }

  let compared = 0;
  for (const file of changedFiles) {
    if (file.status === 'added') {
      for (const s of byFile.get(file.path) ?? []) s.isNew = true;
      continue;
    }
    // Ask git for the path as it was NAMED at base (renames included).
    const oldPath = file.oldPath ?? file.path;
    const gitPath = toGitRelative(oldPath, projectRoot, gitRoot);
    const oldSource = gitShowFile(gitRoot, base, gitPath);
    if (oldSource === null) continue;

    let oldNodes: Node[];
    try {
      oldNodes = cg.extractFromSource(file.path, oldSource).nodes;
    } catch {
      continue;
    }
    if (oldNodes.length === 0) continue;
    compared++;

    const oldByKey = new Map<string, Node>();
    for (const n of oldNodes) {
      if (!REVIEWABLE_KINDS.has(n.kind)) continue;
      oldByKey.set(symbolKey(n), n);
    }

    const currentNodes = cg.getNodesInFile(file.path);
    const currentKeys = new Set(currentNodes.filter(n => REVIEWABLE_KINDS.has(n.kind)).map(symbolKey));

    // Signature drift + newly added symbols.
    for (const sym of byFile.get(file.path) ?? []) {
      const old = oldByKey.get(symbolKey(sym.node));
      if (!old) {
        sym.isNew = true;
        continue;
      }
      const before = normalizeSignature(old.signature);
      const after = normalizeSignature(sym.node.signature);
      if (before && after && before !== after) sym.oldSignature = before;
    }

    // Symbols that existed at base and are gone now. Their call EDGES went with
    // them (an edge needs both endpoints), so the call sites that still use the
    // symbol now sit in unresolved_refs — that is the precise evidence. File-
    // level importers are the weaker fallback for the cases the resolver never
    // recorded a reference for (re-exports, type-only usage).
    for (const [key, old] of oldByKey) {
      if (currentKeys.has(key)) continue;
      if (old.isExported === false) continue; // a private helper going away is not a contract break

      const danglingSites: string[] = [];
      try {
        for (const ref of cg.getUnresolvedReferencesByName(old.name)) {
          if (!ref.filePath || changedFiles.some(f => f.path === ref.filePath)) continue;
          danglingSites.push(`${ref.filePath}:${ref.line} still references \`${old.name}\``);
          if (danglingSites.length >= 10) break;
        }
      } catch {
        // Older index without the table — fall through to importers.
      }

      const importers = cg
        .getFileDependents(file.path)
        .filter(d => !changedFiles.some(f => f.path === d))
        .map(d => `${d} imports this module`);

      removed.push({
        file: file.path,
        name: old.qualifiedName || old.name,
        signature: old.signature,
        danglingSites,
        importers: importers.slice(0, 10),
      });
    }
  }

  if (compared === 0) {
    notes.push(
      `Could not read any changed file at \`${base}\` — breaking-change detection was skipped. ` +
      'Check that the ref exists locally (e.g. `git fetch origin main`).'
    );
  }
}

function toGitRelative(indexRelative: string, projectRoot: string, gitRoot: string): string {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const gr = gitRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (root === gr) return indexRelative;
  if (root.startsWith(gr + '/')) return `${root.slice(gr.length + 1)}/${indexRelative}`;
  return indexRelative;
}

function symbolKey(n: Node): string {
  // qualifiedName carries the container, so `A.run` and `B.run` stay distinct;
  // it is also stable across a pure body edit, which is what we want to compare.
  return `${n.kind}:${n.qualifiedName || n.name}`;
}

function buildFindings(
  symbols: ChangedSymbol[],
  removed: RemovedSymbol[],
): Finding[] {
  const findings: Finding[] = [];

  for (const sym of symbols) {
    const label = sym.node.qualifiedName || sym.node.name;
    const site = `${sym.node.filePath}:${sym.node.startLine}`;

    if (sym.oldSignature) {
      const external = sym.externalCallers;
      findings.push({
        kind: 'breaking-signature',
        severity: external.length > 0 ? 'high' : 'low',
        symbol: label,
        file: sym.node.filePath,
        line: sym.node.startLine,
        message: external.length > 0
          ? `Signature changed and ${external.length} call site(s) OUTSIDE this diff still use the old shape — verify each one.\n  before: ${sym.oldSignature}\n  after:  ${normalizeSignature(sym.node.signature)}`
          : `Signature changed; every known call site is inside this diff.\n  before: ${sym.oldSignature}\n  after:  ${normalizeSignature(sym.node.signature)}`,
        evidence: external.map(c => callSiteLabel(c)),
      });
    } else if (sym.externalCallers.length > 0 && sym.blastRadius >= DEFAULTS.wideBlastRadius) {
      findings.push({
        kind: 'wide-blast-radius',
        severity: 'medium',
        symbol: label,
        file: sym.node.filePath,
        line: sym.node.startLine,
        message: `Changed behavior reaches ${sym.blastRadius} dependent symbol(s); ${sym.externalCallers.length} direct call site(s) are outside this diff.`,
        evidence: sym.externalCallers.slice(0, 6).map(c => callSiteLabel(c)),
      });
    }

    if (sym.coveringTests.length === 0 && sym.node.isExported !== false && sym.blastRadius > 0) {
      findings.push({
        kind: 'missing-test',
        severity: sym.blastRadius >= DEFAULTS.wideBlastRadius ? 'medium' : 'low',
        symbol: label,
        file: sym.node.filePath,
        line: sym.node.startLine,
        message: `No test file reaches this symbol, yet ${sym.blastRadius} symbol(s) depend on it.`,
        evidence: [],
      });
    }

    if (SURFACE_KINDS.has(sym.node.kind)) {
      findings.push({
        kind: 'public-surface-change',
        severity: 'medium',
        symbol: label,
        file: sym.node.filePath,
        line: sym.node.startLine,
        message: `A ${sym.node.kind} changed — this is contract surface; every implementor/consumer has to agree.`,
        evidence: sym.externalCallers.slice(0, 6).map(c => callSiteLabel(c)),
      });
    }

    if (sym.isNew && sym.callers.length === 0 && sym.node.kind !== 'route') {
      findings.push({
        kind: 'new-symbol-no-callers',
        severity: 'low',
        symbol: label,
        file: sym.node.filePath,
        line: sym.node.startLine,
        message: 'New symbol with no caller in the graph — dead on arrival, or reached only dynamically.',
        evidence: [site],
      });
    }
  }

  for (const r of removed) {
    // A dangling reference is proof the removal broke something; an importer is
    // only a lead. Severity follows that difference so a reviewer's attention
    // lands on the provable break first.
    const message = r.danglingSites.length > 0
      ? `Exported symbol removed/renamed, and ${r.danglingSites.length} reference(s) outside this diff no longer resolve to anything — these are broken now.`
      : r.importers.length > 0
        ? `Exported symbol removed/renamed. ${r.importers.length} file(s) outside this diff import this module — confirm none reference it.`
        : 'Exported symbol removed/renamed; no other file imports this module.';
    findings.push({
      kind: 'removed-symbol',
      severity: r.danglingSites.length > 0 ? 'high' : r.importers.length > 0 ? 'medium' : 'low',
      symbol: r.name,
      file: r.file,
      message,
      evidence: [...r.danglingSites, ...r.importers],
    });
  }

  // Anything a reviewer must not miss floats to the top.
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file));
}

function callSiteLabel(c: { node: Node; edge: Edge }): string {
  const line = c.edge.line ?? c.node.startLine;
  const synth = synthLabel(c.edge);
  return `${c.node.filePath}:${line} ${c.node.qualifiedName || c.node.name}${synth ? `  [${synth}]` : ''}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SEVERITY_TAG: Record<Severity, string> = { high: 'HIGH', medium: 'MED', low: 'LOW' };

/**
 * Render the report for an LLM reviewer. Structure only by default: the caller
 * already holds the diff, so re-emitting bodies would double the token bill for
 * text it can already see.
 */
export function renderReviewMarkdown(
  report: ReviewReport,
  cg: CodeGraph,
  opts: ReviewOptions = {},
): string {
  const maxChars = Math.max(2000, opts.maxChars ?? DEFAULTS.maxChars);
  const includeSource = opts.includeSource ?? 'none';
  const out: string[] = [];

  const scope = report.base
    ? `${report.base}${report.head ? `...${report.head}` : ' → working tree'}`
    : 'uncommitted changes (HEAD → working tree)';

  out.push(
    `# Review context — ${report.changedFiles.length} file(s), ${report.symbols.length} changed symbol(s)`,
    `Scope: ${scope}`,
  );

  if (report.changedFiles.length === 0) {
    out.push(
      '',
      'No changed files were detected. Nothing to review — this is not an error.',
      ...report.notes.map(n => `- ${n}`),
    );
    return out.join('\n');
  }

  // --- Findings first: this is the part a reviewer must not skim past. ------
  if (report.findings.length > 0) {
    const high = report.findings.filter(f => f.severity === 'high').length;
    out.push('', `## Findings (${report.findings.length}${high ? `, ${high} HIGH` : ''})`);
    out.push(
      '_Derived from the graph, not from reading the diff. Each one is a claim you can check at the file:line given._',
    );
    for (const f of report.findings) {
      out.push('', `### ${SEVERITY_TAG[f.severity]} · ${f.kind} · \`${f.symbol}\``);
      out.push(`${f.file}${f.line ? `:${f.line}` : ''}`);
      out.push(f.message);
      for (const e of f.evidence.slice(0, 8)) out.push(`  - ${e}`);
      if (f.evidence.length > 8) out.push(`  - …${f.evidence.length - 8} more`);
    }
  } else {
    out.push('', '## Findings (0)', 'No structural risks detected in the changed symbols.');
  }

  // --- Changed symbols + who calls them ------------------------------------
  if (report.symbols.length > 0) {
    out.push('', '## Changed symbols and their call sites');
    const byFile = new Map<string, ChangedSymbol[]>();
    for (const s of report.symbols) {
      const list = byFile.get(s.node.filePath) ?? [];
      list.push(s);
      byFile.set(s.node.filePath, list);
    }
    for (const [file, syms] of byFile) {
      out.push('', `### ${file}`);
      for (const s of syms) {
        const n = s.node;
        const flags: string[] = [];
        if (s.isNew) flags.push('new');
        if (s.oldSignature) flags.push('signature changed');
        if (s.coveringTests.length === 0) flags.push('no test');
        out.push(
          `- \`${n.qualifiedName || n.name}\` (${n.kind}, L${n.startLine}-${n.endLine})` +
          ` — ${s.callers.length} caller(s), ${s.externalCallers.length} outside diff · blast radius ${s.blastRadius}` +
          (flags.length ? ` · ${flags.join(', ')}` : ''),
        );
        if (n.signature) out.push(`    sig: ${normalizeSignature(n.signature)}`);
        for (const c of s.callers) {
          const inDiff = report.changedFiles.some(f => f.path === c.node.filePath);
          out.push(`    ← ${callSiteLabel(c)}${inDiff ? ' (in diff)' : ''}`);
          // A caller's body is the code that actually breaks when a signature
          // moves, so `callers` is the scope worth paying tokens for first.
          if ((includeSource === 'callers' || includeSource === 'all') && !inDiff) {
            const csrc = readSymbolSource(cg, c.node);
            if (csrc) out.push('```', csrc, '```');
          }
        }
        if (s.coveringTests.length > 0) {
          out.push(`    tests: ${s.coveringTests.slice(0, 4).join(', ')}`);
        }
        if (includeSource === 'changed' || includeSource === 'all') {
          const src = readSymbolSource(cg, n);
          if (src) out.push('```', src, '```');
        }
      }
    }
  }

  // --- Ripple: the part a plain diff can never show ------------------------
  if (report.rippleFiles.length > 0) {
    out.push('', `## Files outside the diff that depend on changed code (${report.rippleFiles.length})`);
    for (const r of report.rippleFiles.slice(0, 40)) {
      out.push(`- ${r.path}${r.callSites ? ` — ${r.callSites} call site(s)` : ' — module-level dependency'}`);
    }
    if (report.rippleFiles.length > 40) out.push(`- …${report.rippleFiles.length - 40} more`);
  }

  if (report.affectedTests.length > 0) {
    out.push('', `## Tests to run (${report.affectedTests.length})`);
    for (const t of report.affectedTests.slice(0, 40)) out.push(`- ${t}`);
    if (report.affectedTests.length > 40) out.push(`- …${report.affectedTests.length - 40} more`);
  }

  const uncovered = report.symbols.filter(s => s.coveringTests.length === 0);
  if (uncovered.length > 0) {
    out.push('', `## Changed symbols no test reaches (${uncovered.length})`);
    for (const s of uncovered.slice(0, 30)) {
      out.push(`- \`${s.node.qualifiedName || s.node.name}\` (${s.node.filePath}:${s.node.startLine})`);
    }
  }

  if (report.notes.length > 0) {
    out.push('', '## Notes');
    for (const n of report.notes) out.push(`- ${n}`);
  }

  out.push(
    '',
    '---',
    'Everything above is pre-computed structure — treat the listed call sites as already located. ' +
    'To read the body of any symbol named here, call `codegraph_explore` with its name instead of opening the file.',
  );

  return truncate(out.join('\n'), maxChars);
}

/**
 * The symbol's body, line-numbered in the same `<n>\t<line>` shape `Read`
 * returns, so a reviewer can quote it without re-opening the file. Read from
 * disk (not from the index) so it reflects the working tree the diff describes.
 */
function readSymbolSource(cg: CodeGraph, node: Node): string | null {
  try {
    const abs = pathResolve(cg.getProjectRoot(), node.filePath);
    const lines = readFileSync(abs, 'utf-8').split('\n');
    const from = Math.max(1, node.startLine);
    const to = Math.min(lines.length, node.endLine);
    if (to < from) return null;
    return lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}\t${l}`)
      .join('\n');
  } catch {
    return null;
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Cut on a line boundary so the tail never ends mid-claim.
  const cut = text.lastIndexOf('\n', maxChars);
  return (
    text.slice(0, cut > 0 ? cut : maxChars) +
    `\n\n…report truncated at ${maxChars} chars. Narrow it with \`files\`, or raise \`maxChars\`.`
  );
}

/** Convenience entry point: analyze + render in the requested format. */
export async function buildReview(cg: CodeGraph, opts: ReviewOptions = {}): Promise<string> {
  const report = await analyzeReview(cg, opts);
  if (opts.format === 'json') return JSON.stringify(toJson(report), null, 2);
  return renderReviewMarkdown(report, cg, opts);
}

function toJson(report: ReviewReport) {
  return {
    base: report.base,
    head: report.head,
    changedFiles: report.changedFiles.map(f => ({ path: f.path, status: f.status, oldPath: f.oldPath })),
    findings: report.findings,
    symbols: report.symbols.map(s => ({
      name: s.node.qualifiedName || s.node.name,
      kind: s.node.kind,
      file: s.node.filePath,
      startLine: s.node.startLine,
      endLine: s.node.endLine,
      signature: s.node.signature,
      oldSignature: s.oldSignature,
      isNew: s.isNew,
      blastRadius: s.blastRadius,
      callers: s.callers.map(c => ({
        name: c.node.qualifiedName || c.node.name,
        file: c.node.filePath,
        line: c.edge.line ?? c.node.startLine,
        dynamic: synthLabel(c.edge),
      })),
      externalCallerCount: s.externalCallers.length,
      coveringTests: s.coveringTests,
    })),
    rippleFiles: report.rippleFiles,
    affectedTests: report.affectedTests,
    notes: report.notes,
  };
}
