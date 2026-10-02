import { GitReviewContext } from './gitContext';
import { coverageNote, fitDiffToBudget } from './reviewPlan';

/** Git collects a diff up to a character cap; re-read with this much headroom when the cap was hit. */
const HEADROOM = 4;
const ABSOLUTE_CAP = 1_500_000;

/**
 * Collect a review diff that does not silently lose files.
 *
 * A truncated diff used to be sent as-is, so everything after the cut was never
 * reviewed. This re-reads with headroom, drops noise (lockfiles, generated and
 * vendored code), keeps whole per-file diffs within `budget`, and records in
 * `coverageNote` which files were left out so the model cannot claim them.
 */
export async function collectCoveredReviewContext(
  collect: (maxDiffCharacters: number) => Promise<GitReviewContext>,
  budget: number,
): Promise<GitReviewContext> {
  let context = await collect(budget);
  if (!context.isRepository) return context;
  if (context.truncated) {
    context = await collect(Math.min(budget * HEADROOM, ABSOLUTE_CAP));
  }
  const fit = fitDiffToBudget(context.changedFiles, context.diff, budget);
  const note = coverageNote(fit);
  return {
    ...context,
    // A diff that did not parse into per-file chunks (e.g. a staged/unstaged split) is kept untouched.
    diff: fit.included.length > 0 || fit.overBudget.length > 0 ? fit.diff : context.diff,
    truncated: fit.overBudget.length > 0 || (context.truncated && fit.included.length === 0),
    ...(note ? { coverageNote: note } : {}),
  };
}
