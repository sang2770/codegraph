import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ParsedFinding {
  severity: FindingSeverity;
  file: string;
  line: number;
  body: string;
  /** The code the model says it is commenting on; used to correct a miscounted line. */
  code?: string;
}

/** Marker blocks of a report with `keep` deciding which survive; text outside any marker is untouched. */
export function filterFindingBlocks(
  markdown: string,
  keep: (finding: ParsedFinding) => boolean,
): string {
  return markdown.replace(MARKER_PATTERN, (block, attributes: string, body: string) => {
    const parsed = parseMarkerAttributes(attributes);
    return parsed && !keep({ ...parsed, body: body.trim() }) ? '' : block;
  });
}

/**
 * The replacement code a finding proposes: the first ```suggestion fenced block
 * in its body (the convention GitLab and GitHub use), without the fence.
 */
export function extractSuggestion(body: string): string | undefined {
  const match = /```suggestion[^\n]*\n([\s\S]*?)\n?```/i.exec(body);
  if (!match) return undefined;
  return match[1]!.replace(/\s+$/, '');
}

/**
 * Turn a suggestion into the text that replaces the flagged lines. Models write
 * suggestions without the file's indentation, so the block is dedented and
 * re-indented to match the first flagged line. Returns undefined when the
 * suggestion is empty or identical to what is already there.
 */
export function buildSuggestionReplacement(
  flaggedLines: readonly string[],
  suggestion: string,
): string | undefined {
  const lines = suggestion.split('\n');
  const indents = lines.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length);
  if (indents.length === 0) return undefined;
  const common = Math.min(...indents);
  const baseIndent = /^\s*/.exec(flaggedLines[0] ?? '')![0];
  const replacement = lines
    .map((line) => (line.trim() ? baseIndent + line.slice(common) : ''))
    .join('\n');
  return replacement === flaggedLines.join('\n') ? undefined : replacement;
}

export interface ReviewFinding extends ParsedFinding {
  /** Stable across re-reviews and line shifts, so a dismissal keeps sticking. */
  id: string;
  /**
   * Trimmed text of the anchored line when the review ran. Used to re-find the
   * finding after the file is edited, instead of trusting a line number that
   * every insertion above invalidates.
   */
  anchorText: string;
}

export interface StoredReview {
  root: string;
  generatedAt: string;
  findings: ReviewFinding[];
}

export interface ResolvedAnchor {
  line: number;
  /** True when the finding was found somewhere other than its recorded line. */
  drifted: boolean;
  /** True when the anchor text could not be found at all. */
  lost: boolean;
}

const REVIEW_KEY = 'codebrain.review.latest.v1';
const DISMISSED_KEY = 'codebrain.review.dismissed.v1';

/** How far from the recorded line to search for a drifted anchor. */
const ANCHOR_SEARCH_RADIUS = 200;

const MARKER_PATTERN = /<!--\s*codebrain-finding\b([\s\S]*?)-->([\s\S]*?)(?=<!--\s*codebrain-finding\b|$)/gi;

const SEVERITY_ALIASES: Readonly<Record<string, FindingSeverity>> = {
  critical: 'critical',
  blocker: 'critical',
  high: 'high',
  major: 'high',
  error: 'high',
  medium: 'medium',
  moderate: 'medium',
  warning: 'medium',
  low: 'low',
  minor: 'low',
  nit: 'low',
  info: 'low',
};

/**
 * Read one marker's attributes without trusting the model to be tidy: any
 * attribute order, single or double quotes, unquoted values, `L42` or `42-45`
 * for a line, and severity synonyms. `code` runs to the last quote because the
 * quoted source line may itself contain quotes.
 */
function parseMarkerAttributes(
  attributes: string,
): { severity: FindingSeverity; file: string; line: number; code?: string } | undefined {
  const codeAt = attributes.search(/\bcode\s*=\s*["']/i);
  const head = codeAt >= 0 ? attributes.slice(0, codeAt) : attributes;
  const values = new Map<string, string>();
  for (const match of head.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)) {
    values.set(match[1]!.toLowerCase(), (match[2] ?? match[3] ?? match[4] ?? '').trim());
  }
  const severity = SEVERITY_ALIASES[(values.get('severity') ?? '').toLowerCase()];
  const file = (values.get('file') ?? values.get('path') ?? '').replace(/^\.\//, '').replace(/^`|`$/g, '');
  const line = Number.parseInt(/\d+/.exec(values.get('line') ?? '')?.[0] ?? '', 10);
  if (!severity || !file || !Number.isFinite(line)) return undefined;
  let code: string | undefined;
  if (codeAt >= 0) {
    code = attributes
      .slice(codeAt)
      .replace(/^code\s*=\s*["']/i, '')
      .replace(/["']\s*$/, '')
      .trim();
  }
  return { severity, file, line: Math.max(1, line), ...(code ? { code } : {}) };
}

const FALLBACK_PATTERN =
  /^(?:\s*(?:[-*]\s*)?(?:#{1,6}\s*)?)\*{0,2}(critical|high|medium|low)\*{0,2}\s*(?:[—:-])\s*[`"]?(.+?)[`"]?(?::|,\s*line\s+)(\d+)\b.*$/gim;

/**
 * Extract findings from a review report.
 *
 * Kept pure and separate from the editor plumbing so the marker contract is
 * testable without a running VS Code instance.
 */
export function parseReviewFindings(markdown: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  for (const match of markdown.matchAll(MARKER_PATTERN)) {
    const attributes = parseMarkerAttributes(match[1] ?? '');
    if (attributes) {
      findings.push({ ...attributes, body: (match[2] ?? '').trim() });
    }
  }
  if (findings.length > 0) {
    return findings;
  }
  for (const match of markdown.matchAll(FALLBACK_PATTERN)) {
    const [, severity, file, line] = match;
    if (severity && file && line) {
      findings.push({
        severity: severity.toLowerCase() as FindingSeverity,
        file,
        line: Math.max(1, Number.parseInt(line, 10)),
        body: match[0].trim(),
      });
    }
  }
  return findings;
}

/**
 * Identity of a finding, deliberately excluding the line number.
 *
 * Line numbers move on every edit above them. Including one would make the same
 * finding look new after an unrelated insertion, so a dismissal would silently
 * stop applying and the finding would come back.
 */
export function findingId(input: {
  file: string;
  severity: string;
  anchorText: string;
  body: string;
}): string {
  const summary = input.body
    .replace(/<!--[^>]*-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return createHash('sha256')
    .update(
      [
        input.file.replaceAll('\\', '/'),
        input.severity.toLowerCase(),
        input.anchorText.trim(),
        summary,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 16);
}

/**
 * Find where a finding's line went after the file was edited.
 *
 * Searches outward from the recorded line for the exact anchor text, preferring
 * the nearest match. Falls back to the recorded line and reports `lost` so the
 * caller can tell the developer the location is no longer trustworthy rather
 * than pointing confidently at the wrong code.
 */
export function resolveAnchor(
  lines: readonly string[],
  recordedLine: number,
  anchorText: string,
): ResolvedAnchor {
  const target = anchorText.trim();
  const index = recordedLine - 1;
  const clamp = (value: number) => Math.min(Math.max(value, 0), Math.max(0, lines.length - 1));

  if (!target) {
    return { line: clamp(index) + 1, drifted: false, lost: false };
  }
  if (lines[index]?.trim() === target) {
    return { line: index + 1, drifted: false, lost: false };
  }
  for (let offset = 1; offset <= ANCHOR_SEARCH_RADIUS; offset += 1) {
    const before = index - offset;
    const after = index + offset;
    if (after < lines.length && lines[after]?.trim() === target) {
      return { line: after + 1, drifted: true, lost: false };
    }
    if (before >= 0 && lines[before]?.trim() === target) {
      return { line: before + 1, drifted: true, lost: false };
    }
  }
  return { line: clamp(index) + 1, drifted: false, lost: true };
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { critical: 3, high: 2, medium: 1, low: 0 };

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Drop repeats of one defect reported by more than one review batch (or twice
 * by one). Two findings are the same when they sit in the same file within a few
 * lines (or quote the same code) and say mostly the same thing; the higher
 * severity survives. Pure code, no model call.
 */
export function dedupeFindings<T extends ParsedFinding>(findings: readonly T[]): T[] {
  const kept: Array<{ finding: T; words: Set<string> }> = [];
  for (const finding of findings) {
    const found = words(finding.body);
    const twin = kept.find(
      (other) =>
        other.finding.file === finding.file &&
        (Math.abs(other.finding.line - finding.line) <= 3 ||
          (!!other.finding.code && other.finding.code === finding.code)) &&
        overlap(other.words, found) >= 0.6,
    );
    if (!twin) {
      kept.push({ finding, words: found });
    } else if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[twin.finding.severity]) {
      twin.finding = finding;
      twin.words = found;
    }
  }
  return kept.map((entry) => entry.finding);
}

/** The marker-plus-body form that {@link parseReviewFindings} reads back. */
export function formatFinding(finding: ParsedFinding): string {
  const code = finding.code ? ` code="${finding.code.replace(/\s+/g, ' ')}"` : '';
  return `<!-- codebrain-finding severity="${finding.severity}" file="${finding.file}" line="${finding.line}"${code} -->\n${finding.body}`;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Correct a finding's line using the code the model quoted, since models
 * routinely miscount lines. Keeps `hint` when its text already matches; otherwise
 * picks the match with the most consecutive following lines, then the nearest to
 * `hint`. Returns `hint` unchanged when the quote is nowhere in the file.
 */
export function relocateByCode(
  lines: readonly string[],
  code: string,
  hint: number,
): { line: number; moved: boolean; found: boolean } {
  const want = code.split('\n').map(squash).filter(Boolean);
  if (want.length === 0) return { line: hint, moved: false, found: false };
  const runAt = (index: number): number => {
    let run = 0;
    while (run < want.length && squash(lines[index + run] ?? '') === want[run]) run += 1;
    return run;
  };
  if (runAt(hint - 1) === want.length) return { line: hint, moved: false, found: true };
  let best: { index: number; run: number; dist: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (squash(lines[index] ?? '') !== want[0]) continue;
    const run = runAt(index);
    const dist = Math.abs(index + 1 - hint);
    if (!best || run > best.run || (run === best.run && dist < best.dist)) best = { index, run, dist };
  }
  return best
    ? { line: best.index + 1, moved: true, found: true }
    : { line: hint, moved: false, found: false };
}

/**
 * Findings and dismissals that survive a window reload.
 *
 * Before this, findings lived in module-level variables: closing the window
 * threw away a review the developer had paid a model to produce.
 */
export class ReviewStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getReview(): StoredReview | undefined {
    return this.context.workspaceState.get<StoredReview>(REVIEW_KEY);
  }

  public async setReview(review: StoredReview): Promise<void> {
    await this.context.workspaceState.update(REVIEW_KEY, review);
  }

  public async clearReview(): Promise<void> {
    await this.context.workspaceState.update(REVIEW_KEY, undefined);
  }

  private dismissedIds(): string[] {
    return this.context.workspaceState.get<string[]>(DISMISSED_KEY, []);
  }

  public isDismissed(id: string): boolean {
    return this.dismissedIds().includes(id);
  }

  public async dismiss(ids: readonly string[]): Promise<void> {
    const merged = new Set([...this.dismissedIds(), ...ids]);
    await this.context.workspaceState.update(DISMISSED_KEY, [...merged]);
  }

  public async restoreAll(): Promise<number> {
    const count = this.dismissedIds().length;
    await this.context.workspaceState.update(DISMISSED_KEY, []);
    return count;
  }

  public get dismissedCount(): number {
    return this.dismissedIds().length;
  }

  /** Findings from the stored review that the developer has not dismissed. */
  public activeFindings(): ReviewFinding[] {
    const dismissed = new Set(this.dismissedIds());
    return (this.getReview()?.findings ?? []).filter(
      (finding) => !dismissed.has(finding.id),
    );
  }
}
