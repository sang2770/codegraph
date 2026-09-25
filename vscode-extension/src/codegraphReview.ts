/**
 * The deterministic half of a CodeBrain review: CodeGraph's `codegraph_review`.
 *
 * `affected` answers "what depends on these files". `codegraph_review` answers
 * what a reviewer actually needs and the diff cannot show: which symbols the
 * changed lines live in, signatures that changed and exports that vanished
 * while call sites OUTSIDE the diff still use them, the blast radius, and the
 * changed symbols no test reaches — every claim with a `file:line`. The model
 * gets it as evidence to verify instead of rediscovering it from the diff.
 *
 * Best-effort by design: a runtime too old for the tool, a repository with no
 * commits, a timeout — the review goes ahead on the diff and graph context it
 * already has, and the reason is logged.
 */

import * as vscode from 'vscode';
import { callMcpTool } from './mcpClient';
import { CodeBrainRuntime, codeBrainEnvironment } from './runtime';

export interface CodeGraphReviewScope {
  /** Commit under review; omitted for the working tree. */
  commit?: { hash: string; parent?: string };
}

/**
 * The refs to hand the tool. The working tree is measured against `HEAD`, so
 * breaking-change detection (the HIGH findings) stays on for uncommitted work;
 * a commit against its parent. A root commit has nothing to compare with, so
 * its changed files are reviewed without a base.
 */
export function reviewArguments(
  root: string,
  scope: CodeGraphReviewScope,
  files: readonly string[],
): Record<string, unknown> {
  const args: Record<string, unknown> = { projectPath: root, format: 'markdown' };
  if (!scope.commit) {
    args.base = 'HEAD';
  } else if (scope.commit.parent) {
    args.base = scope.commit.parent;
    args.head = scope.commit.hash;
  } else if (files.length > 0) {
    args.files = [...files];
  }
  return args;
}

/** A report that says nothing is worth no prompt space. */
function isUsefulReport(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^#\s*Review context/m.test(trimmed);
}

export async function fetchCodeGraphReview(
  runtime: CodeBrainRuntime,
  root: string,
  scope: CodeGraphReviewScope,
  files: readonly string[],
  token: vscode.CancellationToken | undefined,
  log: (message: string) => void,
): Promise<string | undefined> {
  const abort = new AbortController();
  const cancellation = token?.onCancellationRequested(() => abort.abort());
  const startedAt = Date.now();
  try {
    const resolved = await runtime.resolve();
    const result = await callMcpTool({
      command: resolved.command,
      args: [...resolved.baseArgs, 'serve', '--mcp'],
      cwd: root,
      env: codeBrainEnvironment(),
      tool: 'codegraph_review',
      toolArgs: reviewArguments(root, scope, files),
      timeoutMs: 120_000,
      signal: abort.signal,
    });
    const elapsed = `${Date.now() - startedAt}ms`;
    if (result.isError) {
      log(`[review] codegraph_review reported an error (${elapsed}): ${result.text.slice(0, 300)}`);
      return undefined;
    }
    if (!isUsefulReport(result.text)) {
      // Expected conditions come back as guidance text, not a report.
      log(`[review] codegraph_review returned no report (${elapsed}): ${result.text.slice(0, 300)}`);
      return undefined;
    }
    log(`[review] codegraph_review: ${result.text.length} chars in ${elapsed}`);
    return result.text.trim();
  } catch (error) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    log(`[review] codegraph_review unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    cancellation?.dispose();
  }
}

/** The report as a prompt section, with how the model should use it. */
export function codeGraphReviewEvidence(report: string | undefined): string {
  if (!report) {
    return '## CodeGraph review report\nNot available for this review; rely on the diff and graph context above.';
  }
  return [
    '## CodeGraph review report (deterministic, from `codegraph_review`)',
    'Pre-computed from the AST and the code graph, not from reading the diff. Every HIGH item (breaking signature, removed symbol still referenced) names concrete call sites outside the diff: verify each against the diff and report every confirmed one as a finding at the changed symbol. Use the untested-symbol and blast-radius sections for the test plan. Do not repeat the report verbatim.',
    report,
  ].join('\n\n');
}
