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

export interface ChatRequestTokenSample {
  command: 'explain' | 'review' | 'impact' | 'fix' | 'guide';
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
    await this.context.workspaceState.update(STORAGE_KEY, {
      ...current,
      lastChatRequest: sample,
    } satisfies TokenSavingSnapshot);
    await vscode.commands.executeCommand(
      'setContext',
      'codebrain.tokenSavings.hasData',
      true,
    );
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
