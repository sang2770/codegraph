import * as vscode from 'vscode';
import { BaselineMeasurement, CHARACTERS_PER_TOKEN } from './baseline';

export interface TokenSavingSample {
  latencyMs: number;
  contextCharacters: number;
  contextTokens: number;
  /**
   * Real cost of reading the candidate files in full, measured from their
   * on-disk sizes. `0` when nothing could be measured.
   */
  baselineTokens: number;
  /** How many candidate files' real sizes back `baselineTokens`. */
  baselineFiles: number;
  /**
   * False when no candidate file could be measured. Savings are then *unknown*
   * rather than zero, and must be reported as unavailable instead of estimated.
   */
  baselineMeasured: boolean;
  tokensSaved: number;
  fileReadsAvoided: number;
  changedFiles: number;
  affectedTests: number;
}

export type ChatCommand =
  | 'explain'
  | 'review'
  | 'impact'
  | 'fix'
  | 'guide'
  | 'implement'
  | 'test'
  | 'pr';

export interface ChatRequestTokenSample {
  command: ChatCommand;
  model: string;
  generatedAt: string;
  codeBrainContextTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  /** Measured full-read cost of the files the graph drew evidence from. */
  baselineTokens: number;
  baselineFiles: number;
  baselineMeasured: boolean;
  /**
   * Size of the graph evidence behind the answer. With `baselineTokens` it
   * gives a like-for-like saving (both at the same bytes-per-token ratio);
   * the model-counted `codeBrainContextTokens` is a different unit.
   */
  contextCharacters?: number;
}

/**
 * One day of activity, the unit the executive report rolls up into weeks and
 * months. Only counts and measured token totals are stored here; anything
 * expressed in hours is derived at report time from assumptions the reader
 * can see and change.
 */
export interface DailyMetrics {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  analyses: number;
  measuredAnalyses: number;
  contextTokens: number;
  baselineTokens: number;
  tokensSaved: number;
  fileReadsAvoided: number;
  /** Chat answers per command. */
  chatRequests: Partial<Record<ChatCommand, number>>;
  chatInputTokens: number;
  chatOutputTokens: number;
  /** Chat answers whose baseline was measurable. */
  chatMeasured: number;
  chatContextTokens: number;
  chatBaselineTokens: number;
  chatTokensSaved: number;
  /** Affected-test runs that targeted specific files rather than the full suite. */
  affectedTestRuns: number;
  affectedTestFiles: number;
  /** Code proposals applied to the workspace, and the files they changed. */
  proposalsApplied: number;
  proposalFiles: number;
}

export interface TokenSavingSnapshot {
  analyses: number;
  /** Analyses whose baseline was measurable; the only ones in the totals below. */
  measuredAnalyses: number;
  totalLatencyMs: number;
  totalContextTokens: number;
  totalBaselineTokens: number;
  totalTokensSaved: number;
  totalFileReadsAvoided: number;
  last?: TokenSavingSample;
  lastChatRequest?: ChatRequestTokenSample;
  /** Oldest first; at most {@link MAX_HISTORY_DAYS} entries. */
  daily?: DailyMetrics[];
}

/** Days of history kept, a little over a year so a yearly report has its baseline month. */
export const MAX_HISTORY_DAYS = 400;

export function emptyDay(date: string): DailyMetrics {
  return {
    date,
    analyses: 0,
    measuredAnalyses: 0,
    contextTokens: 0,
    baselineTokens: 0,
    tokensSaved: 0,
    fileReadsAvoided: 0,
    chatRequests: {},
    chatInputTokens: 0,
    chatOutputTokens: 0,
    chatMeasured: 0,
    chatContextTokens: 0,
    chatBaselineTokens: 0,
    chatTokensSaved: 0,
    affectedTestRuns: 0,
    affectedTestFiles: 0,
    proposalsApplied: 0,
    proposalFiles: 0,
  };
}

/** Local `YYYY-MM-DD`, so a day matches the reader's calendar rather than UTC's. */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * `daily` with today's entry updated by `change`, trimmed to the history cap.
 *
 * Pure so the roll-over and trimming are testable without a workspace.
 */
export function updateDaily(
  daily: readonly DailyMetrics[] | undefined,
  date: string,
  change: (day: DailyMetrics) => DailyMetrics,
): DailyMetrics[] {
  const days = [...(daily ?? [])];
  const index = days.findIndex((day) => day.date === date);
  if (index === -1) {
    days.push(change(emptyDay(date)));
    days.sort((a, b) => a.date.localeCompare(b.date));
  } else {
    // Older entries may predate a field; fill it in rather than produce NaN.
    days[index] = change({ ...emptyDay(date), ...days[index]! });
  }
  return days.slice(-MAX_HISTORY_DAYS);
}

/** Like-for-like saving of one chat answer, or `undefined` when unmeasurable. */
export function chatSaving(
  sample: Pick<ChatRequestTokenSample, 'baselineMeasured' | 'baselineTokens' | 'contextCharacters'>,
): { contextTokens: number; saved: number } | undefined {
  if (!sample.baselineMeasured || sample.contextCharacters === undefined) {
    return undefined;
  }
  const contextTokens = Math.ceil(sample.contextCharacters / CHARACTERS_PER_TOKEN);
  return { contextTokens, saved: Math.max(0, sample.baselineTokens - contextTokens) };
}

// v2: v1 totals were produced by a guessed per-file constant and a fixed 6.5x
// chat multiplier, so they are not comparable with measured values. Starting a
// new key retires those inflated numbers instead of averaging them in.
const STORAGE_KEY = 'codebrain.tokenSavings.v2';

const EMPTY: TokenSavingSnapshot = {
  analyses: 0,
  measuredAnalyses: 0,
  totalLatencyMs: 0,
  totalContextTokens: 0,
  totalBaselineTokens: 0,
  totalTokensSaved: 0,
  totalFileReadsAvoided: 0,
};

export class MetricsStore {
  public constructor(private readonly context: vscode.ExtensionContext) {
    const snapshot = this.snapshot();
    void vscode.commands.executeCommand(
      'setContext',
      'codebrain.tokenSavings.hasData',
      snapshot.analyses > 0 || snapshot.lastChatRequest !== undefined,
    );
  }

  public snapshot(): TokenSavingSnapshot {
    return {
      ...EMPTY,
      ...this.context.workspaceState.get<TokenSavingSnapshot>(STORAGE_KEY, EMPTY),
    };
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('codebrain')
      .get<boolean>('metrics.enabled', true);
  }

  public async record(sample: TokenSavingSample): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const current = this.snapshot();
    await this.context.workspaceState.update(STORAGE_KEY, {
      ...current,
      analyses: current.analyses + 1,
      // Only measured samples contribute to the totals, so the dashboard never
      // mixes a real measurement with an unmeasurable one.
      measuredAnalyses: current.measuredAnalyses + (sample.baselineMeasured ? 1 : 0),
      totalLatencyMs: current.totalLatencyMs + sample.latencyMs,
      totalContextTokens:
        current.totalContextTokens + (sample.baselineMeasured ? sample.contextTokens : 0),
      totalBaselineTokens: current.totalBaselineTokens + sample.baselineTokens,
      totalTokensSaved: current.totalTokensSaved + sample.tokensSaved,
      totalFileReadsAvoided:
        current.totalFileReadsAvoided + sample.fileReadsAvoided,
      last: sample,
      daily: updateDaily(current.daily, localDay(new Date()), (day) => ({
        ...day,
        analyses: day.analyses + 1,
        measuredAnalyses: day.measuredAnalyses + (sample.baselineMeasured ? 1 : 0),
        contextTokens: day.contextTokens + (sample.baselineMeasured ? sample.contextTokens : 0),
        baselineTokens: day.baselineTokens + sample.baselineTokens,
        tokensSaved: day.tokensSaved + sample.tokensSaved,
        fileReadsAvoided: day.fileReadsAvoided + sample.fileReadsAvoided,
      })),
    } satisfies TokenSavingSnapshot);
    await vscode.commands.executeCommand(
      'setContext',
      'codebrain.tokenSavings.hasData',
      true,
    );
  }

  public async recordChatRequest(sample: ChatRequestTokenSample): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const current = this.snapshot();
    const saving = chatSaving(sample);
    await this.context.workspaceState.update(STORAGE_KEY, {
      ...current,
      lastChatRequest: sample,
      daily: updateDaily(current.daily, localDay(new Date()), (day) => ({
        ...day,
        chatRequests: {
          ...day.chatRequests,
          [sample.command]: (day.chatRequests[sample.command] ?? 0) + 1,
        },
        chatInputTokens: day.chatInputTokens + sample.inputTokens,
        chatOutputTokens: day.chatOutputTokens + sample.outputTokens,
        chatMeasured: day.chatMeasured + (saving ? 1 : 0),
        chatContextTokens: day.chatContextTokens + (saving?.contextTokens ?? 0),
        chatBaselineTokens: day.chatBaselineTokens + (saving ? sample.baselineTokens : 0),
        chatTokensSaved: day.chatTokensSaved + (saving?.saved ?? 0),
      })),
    } satisfies TokenSavingSnapshot);
    await vscode.commands.executeCommand(
      'setContext',
      'codebrain.tokenSavings.hasData',
      true,
    );
  }

  /** An affected-test run that targeted `files` test files instead of the whole suite. */
  public async recordAffectedTestRun(files: number): Promise<void> {
    await this.updateToday((day) => ({
      ...day,
      affectedTestRuns: day.affectedTestRuns + 1,
      affectedTestFiles: day.affectedTestFiles + files,
    }));
  }

  /** A code proposal applied from chat, changing `files` files. */
  public async recordProposalApplied(files: number): Promise<void> {
    await this.updateToday((day) => ({
      ...day,
      proposalsApplied: day.proposalsApplied + 1,
      proposalFiles: day.proposalFiles + files,
    }));
  }

  private async updateToday(change: (day: DailyMetrics) => DailyMetrics): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const current = this.snapshot();
    await this.context.workspaceState.update(STORAGE_KEY, {
      ...current,
      daily: updateDaily(current.daily, localDay(new Date()), change),
    } satisfies TokenSavingSnapshot);
  }

  public async reset(): Promise<void> {
    await this.context.workspaceState.update(STORAGE_KEY, EMPTY);
    await vscode.commands.executeCommand(
      'setContext',
      'codebrain.tokenSavings.hasData',
      false,
    );
  }
}

/**
 * Turn a measured read baseline into a reportable sample.
 *
 * `baseline` must come from {@link measureFileReadBaseline}, i.e. from real file
 * sizes. When nothing could be measured the sample reports `baselineMeasured:
 * false` and zero savings, which callers must surface as "not measurable"
 * rather than as "no savings".
 */
export function measureTokenSaving(input: {
  contextCharacters: number;
  baseline: BaselineMeasurement;
  changedFiles: number;
  affectedTests: number;
  latencyMs: number;
}): TokenSavingSample {
  const contextTokens = Math.ceil(input.contextCharacters / CHARACTERS_PER_TOKEN);
  const baselineTokens = input.baseline.measured ? input.baseline.tokens : 0;
  return {
    latencyMs: input.latencyMs,
    contextCharacters: input.contextCharacters,
    contextTokens,
    baselineTokens,
    baselineFiles: input.baseline.measuredFiles,
    baselineMeasured: input.baseline.measured,
    // A graph answer can legitimately be larger than the files it cites (it
    // adds call paths and blast radius). Clamping at zero keeps that from being
    // reported as negative savings, and the flag above keeps it honest.
    tokensSaved: input.baseline.measured
      ? Math.max(0, baselineTokens - contextTokens)
      : 0,
    fileReadsAvoided: input.baseline.measuredFiles,
    changedFiles: input.changedFiles,
    affectedTests: input.affectedTests,
  };
}

/**
 * Human-readable savings ratio, or `undefined` when the baseline could not be
 * measured. Never fabricates a percentage.
 */
export function savingsPercent(sample: {
  baselineMeasured: boolean;
  baselineTokens: number;
  contextTokens: number;
}): number | undefined {
  if (!sample.baselineMeasured || sample.baselineTokens <= 0) {
    return undefined;
  }
  const saved = sample.baselineTokens - sample.contextTokens;
  return Math.round((saved / sample.baselineTokens) * 100);
}
