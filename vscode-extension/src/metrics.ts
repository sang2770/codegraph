import * as vscode from 'vscode';

export interface TokenSavingSample {
  latencyMs: number;
  contextCharacters: number;
  contextTokens: number;
  baselineTokens: number;
  tokensSaved: number;
  fileReadsAvoided: number;
  changedFiles: number;
  affectedTests: number;
}

export interface ChatRequestTokenSample {
  command: 'explain' | 'review' | 'impact';
  model: string;
  generatedAt: string;
  codeBrainContextTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export interface TokenSavingSnapshot {
  analyses: number;
  totalLatencyMs: number;
  totalContextTokens: number;
  totalBaselineTokens: number;
  totalTokensSaved: number;
  totalFileReadsAvoided: number;
  last?: TokenSavingSample;
  lastChatRequest?: ChatRequestTokenSample;
}

const STORAGE_KEY = 'codebrain.tokenSavings.v1';

const EMPTY: TokenSavingSnapshot = {
  analyses: 0,
  totalLatencyMs: 0,
  totalContextTokens: 0,
  totalBaselineTokens: 0,
  totalTokensSaved: 0,
  totalFileReadsAvoided: 0,
};

export class MetricsStore {
  public constructor(private readonly context: vscode.ExtensionContext) {
    void vscode.commands.executeCommand(
      'setContext',
      'codebrain.tokenSavings.hasData',
      this.snapshot().analyses > 0 || this.snapshot().lastChatRequest !== undefined,
    );
  }

  public snapshot(): TokenSavingSnapshot {
    return this.context.workspaceState.get<TokenSavingSnapshot>(
      STORAGE_KEY,
      EMPTY,
    );
  }

  public async record(sample: TokenSavingSample): Promise<void> {
    if (
      !vscode.workspace
        .getConfiguration('codebrain')
        .get<boolean>('metrics.enabled', true)
    ) {
      return;
    }
    const current = this.snapshot();
    await this.context.workspaceState.update(STORAGE_KEY, {
      ...current,
      analyses: current.analyses + 1,
      totalLatencyMs: current.totalLatencyMs + sample.latencyMs,
      totalContextTokens: current.totalContextTokens + sample.contextTokens,
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
    if (
      !vscode.workspace
        .getConfiguration('codebrain')
        .get<boolean>('metrics.enabled', true)
    ) {
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

export function estimateTokenSaving(
  contextCharacters: number,
  changedFiles: number,
  dependents: number,
  affectedTests: number,
  latencyMs: number,
): TokenSavingSample {
  const contextTokens = Math.ceil(contextCharacters / 4);
  const candidateFiles = Math.max(
    changedFiles,
    changedFiles + dependents + affectedTests,
  );
  const baselineTokens = Math.max(
    contextTokens,
    candidateFiles * 900,
  );
  return {
    latencyMs,
    contextCharacters,
    contextTokens,
    baselineTokens,
    tokensSaved: Math.max(0, baselineTokens - contextTokens),
    fileReadsAvoided: Math.max(0, candidateFiles - changedFiles),
    changedFiles,
    affectedTests,
  };
}
