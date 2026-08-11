import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ParsedFinding {
  severity: FindingSeverity;
  file: string;
  line: number;
  body: string;
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

const MARKER_PATTERN =
  /<!--\s*codebrain-finding\s+severity="(critical|high|medium|low)"\s+file="([^"]+)"\s+line="(\d+)"\s*-->([\s\S]*?)(?=<!--\s*codebrain-finding|$)/gi;

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
    const [, severity, file, line, body] = match;
    if (severity && file && line && body !== undefined) {
      findings.push({
        severity: severity.toLowerCase() as FindingSeverity,
        file,
        line: Math.max(1, Number.parseInt(line, 10)),
        body: body.trim(),
      });
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
