import { ParsedFinding } from './reviewStore';

/**
 * Optional second pass, ported from Open Code Review's finding filter: a model
 * that sees only the diff may remove a finding solely when the diff PROVES it
 * wrong. The cost of keeping a wrong finding is a few seconds of a reviewer's
 * attention; the cost of dropping a right one is that nobody ever sees it, so
 * every doubt resolves to "keep".
 */
export function buildVerifyPrompt(findings: readonly ParsedFinding[], diff: string): string {
  const list = findings
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.file}:${finding.line}${finding.code ? ` — \`${finding.code}\`` : ''}\n${finding.body.replace(/```suggestion[\s\S]*?```/gi, '').trim().slice(0, 1_200)}`,
    )
    .join('\n\n');
  return `You are a fact-checker for code review findings.

The findings below were written by a reviewer that could read the whole codebase. You can see only the diff. Anything you cannot see, the reviewer may well have seen.

Remove ONLY a finding that this diff PROVES to be factually wrong (for example it claims a check is missing and the diff shows the check, or it describes a line the diff does not contain). You are not judging whether a finding is useful, important or well written.

Keeping a wrong finding costs a reviewer a few seconds. Removing a correct finding silently destroys it. So when evidence falls short of proof — "suspicious", "I cannot verify this", "looks fine to me", "I would not have raised it" — keep it.

Reply with ONLY a JSON array: [{"id": 2, "reason": "the diff shows line X already checks it"}]. Use [] when nothing is provably wrong.

## Findings
${list}

## Git diff
${diff}`;
}

/**
 * Read the verifier's reply into the findings to drop. Anything unparsable,
 * out of range, or without a reason drops nothing: a malformed reply must never
 * delete findings.
 */
export function parseVerifyReply(
  reply: string,
  count: number,
): Array<{ index: number; reason: string }> {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const dropped = new Map<number, string>();
  for (const item of parsed) {
    const id = Number((item as { id?: unknown })?.id);
    const reason = String((item as { reason?: unknown })?.reason ?? '').trim();
    if (Number.isInteger(id) && id >= 1 && id <= count && reason) {
      dropped.set(id - 1, reason);
    }
  }
  return [...dropped].map(([index, reason]) => ({ index, reason }));
}
