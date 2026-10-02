/**
 * Deterministic review planning, ported from the approach of Open Code Review:
 * decide in code — not in the prompt — which files get reviewed, which checklist
 * applies to each, and how to split a large change into units small enough that
 * the model reviews every file instead of cutting corners.
 */

const EXCLUDED: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|gradle\.lockfile)$/, 'lockfile'],
  [/\.min\.(js|css)$|\.map$/, 'minified or sourcemap'],
  [/(^|\/)(node_modules|vendor|third_party|dist|build|out|\.next|__pycache__)\//, 'vendored or build output'],
  [/\.(png|jpe?g|gif|ico|webp|svg|pdf|zip|gz|jar|woff2?|ttf|eot|mp[34]|wasm|vsix)$/i, 'binary or asset'],
  [/\.pb\.go$|_pb2(_grpc)?\.py$|\.generated\.[a-z]+$/, 'generated code'],
];

export function excludeReason(path: string): string | undefined {
  for (const [pattern, reason] of EXCLUDED) {
    if (pattern.test(path)) return reason;
  }
  return undefined;
}

const DEFAULT_RULE: readonly string[] = [
  'Correctness first: wrong logic, off-by-one, null/undefined, unchecked errors, resource leaks, races.',
  'Security: injection, secrets, unsafe deserialization, missing authorization checks.',
  'Changed public signatures: confirm callers outside the diff were updated.',
  'Skip style and naming unless it hides a bug. Report only what you can point to in the code.',
];

const RULES: Readonly<Record<string, { match: RegExp; checks: readonly string[] }>> = {
  'ts-js': { match: /\.(ts|tsx|js|jsx|mjs|cjs)$/, checks: ['Unhandled promise rejections, missing await.', 'Loose equality, `any` hiding a type error, unchecked JSON.parse.', 'React: stale closures, missing hook dependencies, state mutation.'] },
  python: { match: /\.pyi?$/, checks: ['Mutable default arguments, bare except, unclosed files or connections.', 'Blocking calls inside async code.'] },
  go: { match: /\.go$/, checks: ['Ignored errors, goroutine leaks, loop-variable capture, missing context cancellation.', 'Unlocked shared state, nil map writes.'] },
  jvm: { match: /\.(java|kt|kts)$/, checks: ['Null handling, resource closing, thread-safety of shared state.', 'Transaction boundaries and swallowed exceptions.'] },
  c: { match: /\.(c|h|cc|cpp|cxx|hpp)$/, checks: ['Buffer bounds, integer overflow, use-after-free, uninitialised variables.', 'Every early return releases what was acquired; header changes need matching callers.'] },
  rust: { match: /\.rs$/, checks: ['unwrap/expect on fallible paths, unsafe blocks, lock ordering.'] },
  sql: { match: /\.sql$|(mapper|dao)[^/]*\.xml$/i, checks: ['Injection through string concatenation, missing indexes, non-reversible migrations.'] },
  config: { match: /\.(ya?ml|json|toml|properties|env)$|(^|\/)Dockerfile$/, checks: ['Committed secrets, wrong environment values, breaking key renames.'] },
  test: { match: /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|c)$/, checks: ['Would the test fail without the fix? Assertions that cannot fail, over-mocking.'] },
};

/** Rule ids that apply to a path; a test file gets its language rule and `test`. */
export function ruleIdsFor(path: string): string[] {
  const ids = Object.entries(RULES)
    .filter(([, rule]) => rule.match.test(path))
    .map(([id]) => id);
  return ids.length > 0 ? ids : ['default'];
}

export function ruleChecks(id: string): readonly string[] {
  return id === 'default' ? DEFAULT_RULE : RULES[id]?.checks ?? [];
}

/** The always-on rule plus the specific rules for the given files, as prompt bullets. */
export function renderRules(paths: readonly string[]): string {
  const ids = [...new Set(paths.flatMap(ruleIdsFor))].filter((id) => id !== 'default').sort();
  return [
    ...DEFAULT_RULE.map((line) => `- ${line}`),
    ...ids.flatMap((id) => [`- ${id} files:`, ...ruleChecks(id).map((line) => `  - ${line}`)]),
  ].join('\n');
}

/** Split a unified `git diff` into per-file chunks keyed by the new path. */
export function splitDiffByFile(diff: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const starts = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  starts.forEach((match, index) => {
    const end = starts[index + 1]?.index ?? diff.length;
    chunks.set(match[2]!, diff.slice(match.index, end).trimEnd());
  });
  return chunks;
}

const stem = (path: string): string => {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const core = path
    .slice(slash + 1)
    .replace(/\.[^.]+$/, '')
    .replace(/\.(test|spec)$/, '')
    .replace(/[._-](test|spec)$/, '')
    .replace(/^test[._-]/, '')
    .replace(/[._-](en|zh|ja|ko|vi|de|fr|ru|[a-z]{2}[-_][A-Z]{2})$/, '');
  return `${dir}\0${core}`;
};

export const MAX_FILES_PER_GROUP = 10;

export interface FileGroup {
  label: string;
  files: string[];
}

/** Bundle related files (source+test, locale variants), then keep directories together; cap group size. */
export function groupFiles(paths: readonly string[]): FileGroup[] {
  const byDir = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  for (const path of paths) {
    byStem.set(stem(path), [...(byStem.get(stem(path)) ?? []), path]);
  }
  for (const [key, files] of byStem) {
    const dir = key.slice(0, key.indexOf('\0'));
    byDir.set(dir, [...(byDir.get(dir) ?? []), ...files]);
  }
  const groups: FileGroup[] = [];
  for (const [dir, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < files.length; i += MAX_FILES_PER_GROUP) {
      const part = files.slice(i, i + MAX_FILES_PER_GROUP);
      const suffix = files.length > MAX_FILES_PER_GROUP ? ` #${i / MAX_FILES_PER_GROUP + 1}` : '';
      groups.push({ label: `${dir || '(repo root)'}${suffix}`, files: part });
    }
  }
  return groups;
}

export interface ReviewBatch {
  label: string;
  files: string[];
  diff: string;
}

export interface ReviewPlan {
  batches: ReviewBatch[];
  excluded: Array<{ path: string; reason: string }>;
  /** Changed files that had no hunk in the diff (untracked, binary, or cut off) and so cannot be reviewed from it. */
  missingDiff: string[];
}

/**
 * Plan a review: drop noise, bundle related files, and pack the bundles into
 * batches whose diff fits `maxBatchCharacters`. A bundle bigger than the budget
 * is split by file; a single file bigger than the budget gets a batch of its own
 * and is cut there rather than crowding out its neighbours.
 */
export function buildReviewPlan(
  changedFiles: readonly string[],
  diff: string,
  maxBatchCharacters: number,
): ReviewPlan {
  const chunks = splitDiffByFile(diff);
  const excluded: ReviewPlan['excluded'] = [];
  const reviewable: string[] = [];
  const missingDiff: string[] = [];
  for (const path of changedFiles) {
    const reason = excludeReason(path);
    if (reason) excluded.push({ path, reason });
    else if (!chunks.has(path)) missingDiff.push(path);
    else reviewable.push(path);
  }

  const batches: ReviewBatch[] = [];
  let current: ReviewBatch | undefined;
  const flush = () => {
    if (current) batches.push(current);
    current = undefined;
  };
  const add = (label: string, path: string) => {
    const raw = chunks.get(path)!;
    const chunk =
      raw.length > maxBatchCharacters
        ? `${raw.slice(0, maxBatchCharacters)}\n[diff for ${path} truncated]`
        : raw;
    if (current && current.diff.length + chunk.length > maxBatchCharacters) flush();
    current ??= { label, files: [], diff: '' };
    current.files.push(path);
    current.diff += `${current.diff ? '\n' : ''}${chunk}`;
  };
  for (const group of groupFiles(reviewable)) {
    const size = group.files.reduce((sum, path) => sum + chunks.get(path)!.length, 0);
    // A group that fits in the remaining room stays together; otherwise it starts a fresh batch.
    if (current && current.diff.length + size > maxBatchCharacters) flush();
    for (const path of group.files) add(group.label, path);
  }
  flush();
  return { batches, excluded, missingDiff };
}

export interface FittedDiff {
  diff: string;
  /** Reviewable files whose whole diff is in `diff`. */
  included: string[];
  /** Reviewable files left out because they did not fit the budget. */
  overBudget: string[];
  excluded: ReviewPlan['excluded'];
  missingDiff: string[];
}

/**
 * Single-prompt counterpart to {@link buildReviewPlan}: drop noise, then keep
 * whole per-file diffs (never a file cut mid-hunk) until the budget is spent, so
 * the report can say exactly which files were and were not seen.
 */
export function fitDiffToBudget(
  changedFiles: readonly string[],
  diff: string,
  budget: number,
): FittedDiff {
  const chunks = splitDiffByFile(diff);
  const excluded: FittedDiff['excluded'] = [];
  const missingDiff: string[] = [];
  const included: string[] = [];
  const overBudget: string[] = [];
  const kept: string[] = [];
  let used = 0;
  for (const path of changedFiles) {
    const reason = excludeReason(path);
    const chunk = chunks.get(path);
    if (reason) excluded.push({ path, reason });
    else if (!chunk) missingDiff.push(path);
    else if (used + chunk.length > budget) overBudget.push(path);
    else {
      kept.push(chunk);
      included.push(path);
      used += chunk.length + 1;
    }
  }
  return { diff: kept.join('\n'), included, overBudget, excluded, missingDiff };
}

/** What was and was not reviewed, as text for a prompt or a report. Empty when everything was. */
export function coverageNote(fit: Pick<FittedDiff, 'overBudget' | 'excluded' | 'missingDiff'>): string {
  const lines: string[] = [];
  if (fit.overBudget.length > 0) {
    lines.push(
      `Not included in the diff above (over the size budget) — do NOT claim these were reviewed:`,
      ...fit.overBudget.slice(0, 40).map((path) => `- ${path}`),
    );
  }
  if (fit.excluded.length > 0) {
    lines.push(
      'Filtered out as noise:',
      ...fit.excluded.slice(0, 40).map((item) => `- ${item.path}: ${item.reason}`),
    );
  }
  if (fit.missingDiff.length > 0) {
    lines.push(
      'Changed but no diff available (new, binary, or cut off):',
      ...fit.missingDiff.slice(0, 40).map((path) => `- ${path}`),
    );
  }
  return lines.length > 0 ? `## Review coverage\n${lines.join('\n')}` : '';
}

export interface CostEstimate {
  requests: number;
  /** Rough input tokens across every request (4 characters per token). */
  inputTokens: number;
}

const PER_REQUEST_OVERHEAD_CHARACTERS = 8_000;

/** Rough cost of reviewing a plan: one model request per batch. */
export function estimateReviewCost(plan: Pick<ReviewPlan, 'batches'>): CostEstimate {
  const characters = plan.batches.reduce(
    (sum, batch) => sum + batch.diff.length + PER_REQUEST_OVERHEAD_CHARACTERS,
    0,
  );
  return { requests: plan.batches.length, inputTokens: Math.ceil(characters / 4) };
}

/** The plan as Markdown for an agent: batches with their rules, plus what is excluded or unreadable. */
export function renderPlanMarkdown(plan: ReviewPlan): string {
  const reviewable = plan.batches.reduce((sum, batch) => sum + batch.files.length, 0);
  const lines = [
    `# Review plan: ${reviewable} file(s) in ${plan.batches.length} batch(es); ${plan.excluded.length} filtered`,
    'Review the batches in order, one at a time, and finish every one. State any file you did not review.',
    '',
  ];
  plan.batches.forEach((batch, index) => {
    lines.push(`## Batch ${index + 1}: ${batch.label}`, ...batch.files.map((file) => `- ${file} (${ruleIdsFor(file).join(', ')})`), '');
  });
  if (plan.excluded.length > 0) {
    lines.push('## Filtered as noise (do not review)', ...plan.excluded.map((item) => `- ${item.path}: ${item.reason}`), '');
  }
  if (plan.missingDiff.length > 0) {
    lines.push('## Changed but no diff available (read the file, or say it was not reviewed)', ...plan.missingDiff.map((path) => `- ${path}`), '');
  }
  lines.push('## Always apply', renderRules(plan.batches.flatMap((batch) => batch.files)));
  return lines.join('\n');
}
