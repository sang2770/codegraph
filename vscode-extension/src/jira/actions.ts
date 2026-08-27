/**
 * The board's actions — everything that talks to the user or changes state.
 *
 * Kept out of the view so the webview's message handler stays a router, and out
 * of the service so loading stays free of prompts. Every flow here ends in a
 * message the user can act on: a git failure is reported with git's own first
 * line, not swallowed.
 */

import * as vscode from 'vscode';
import { AtlassianClient } from '../atlassian/client';
import { AtlassianIntegration } from '../atlassianSetup';
import {
  branchNameFor,
  BranchInfo,
  createBranch,
  fetchRemotes,
  GitOutcome,
  hasUncommittedChanges,
  isValidBranchName,
  planCheckout,
  sanitizeBranchName,
  switchBranch,
  trackRemoteBranch,
} from './branches';
import { BoardIssue } from './model';
import { BoardConfig, RepositoryState } from './service';

/** Open an issue in the browser. */
export async function openIssue(issue: BoardIssue): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(issue.url));
}

/** Put the issue key on the clipboard — the fastest path into a commit message. */
export async function copyIssueKey(issue: BoardIssue): Promise<void> {
  await vscode.env.clipboard.writeText(issue.key);
  void vscode.window.setStatusBarMessage(`Copied ${issue.key}`, 2000);
}

/**
 * Ask CodeBrain about a ticket in Chat.
 *
 * Best-effort, like everywhere else the extension opens Chat: the command id
 * differs across VS Code versions, so a failure falls back to the clipboard
 * rather than an error the developer cannot act on.
 */
export async function askAboutIssue(issue: BoardIssue): Promise<void> {
  const query = `@codebrain /explain Jira ${issue.key} — ${issue.summary}. Find the code this ticket is about and explain the workflow it touches.`;
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query });
  } catch {
    await vscode.env.clipboard.writeText(query);
    void vscode.window.showInformationMessage(
      'CodeBrain copied the question to your clipboard — paste it into Chat.',
    );
  }
}

function describeBranch(branch: BranchInfo): vscode.QuickPickItem {
  const when = branch.committedAt
    ? new Date(branch.committedAt).toLocaleDateString()
    : undefined;
  return {
    label: branch.isRemote ? `$(cloud) ${branch.name}` : `$(git-branch) ${branch.name}`,
    description: [
      branch.isCurrent ? 'current' : undefined,
      branch.isRemote ? 'remote only' : undefined,
      when,
    ]
      .filter(Boolean)
      .join(' · '),
    detail: branch.subject,
  };
}

/**
 * Check out the branch for an issue, creating or tracking one when needed.
 *
 * The decision itself lives in {@link planCheckout}; this is the conversation
 * around it — disambiguating several matching branches, confirming a switch
 * that would carry uncommitted work along, and letting the generated name be
 * edited before a branch is created from it.
 */
export async function checkoutForIssue(
  issue: BoardIssue,
  repository: RepositoryState,
  config: BoardConfig,
): Promise<GitOutcome | undefined> {
  if (!repository.root || !repository.isRepository) {
    void vscode.window.showWarningMessage(
      'CodeBrain: open a Git repository to map a Jira ticket onto a branch.',
    );
    return undefined;
  }
  const root = repository.root;

  const suggestion = branchNameFor(issue, config.branchTemplate);
  const plan = planCheckout(repository.branches, issue.key, suggestion);

  if (plan.alreadyOnBranch) {
    void vscode.window.showInformationMessage(
      `CodeBrain: already on ${plan.branch} for ${issue.key}.`,
    );
    return { ok: true, message: `Already on ${plan.branch}.` };
  }

  // More than one branch carries the key — a stale one from last sprint and the
  // real one, typically. Guessing here is the wrong kind of convenient.
  let target = plan;
  if (plan.candidates.length > 1) {
    const items: (vscode.QuickPickItem & { branch?: BranchInfo })[] = [
      ...plan.candidates.map((branch) => ({ ...describeBranch(branch), branch })),
      {
        label: '$(add) Create a new branch…',
        description: suggestion,
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `${issue.key} — ${issue.summary}`,
      placeHolder: `${plan.candidates.length} branches carry ${issue.key}`,
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    if (picked.branch) {
      target = picked.branch.isRemote
        ? {
            action: 'track',
            branch: picked.branch.localName,
            remoteRef: picked.branch.name,
            candidates: plan.candidates,
            alreadyOnBranch: false,
          }
        : {
            action: 'switch',
            branch: picked.branch.name,
            candidates: plan.candidates,
            alreadyOnBranch: false,
          };
    } else {
      target = { action: 'create', branch: suggestion, candidates: plan.candidates, alreadyOnBranch: false };
    }
  }

  // Switching an existing branch carries uncommitted work with it, or fails
  // half-way; creating a branch intentionally takes the work along, which is
  // the normal "I started before I made the branch" flow.
  if (target.action !== 'create' && (await hasUncommittedChanges(root))) {
    const choice = await vscode.window.showWarningMessage(
      `You have uncommitted changes. Switching to ${target.branch} will try to carry them over.`,
      { modal: true },
      'Switch anyway',
    );
    if (choice !== 'Switch anyway') return undefined;
  }

  if (target.action === 'create') {
    const entered = await vscode.window.showInputBox({
      title: `New branch for ${issue.key}`,
      prompt: config.baseBranch
        ? `Created from ${config.baseBranch}. Change the template with codebrain.jira.branchTemplate.`
        : 'Created from the current HEAD. Change the template with codebrain.jira.branchTemplate.',
      value: target.branch,
      valueSelection: [target.branch.length, target.branch.length],
      ignoreFocusOut: true,
      validateInput: (input) => {
        const trimmed = input.trim();
        if (!trimmed) return 'Enter a branch name.';
        if (!isValidBranchName(trimmed)) {
          return `Git will not accept that name. Try ${sanitizeBranchName(trimmed) || suggestion}.`;
        }
        return undefined;
      },
    });
    if (entered === undefined) return undefined;
    target = { ...target, branch: entered.trim() };
  }

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `CodeBrain: ${issue.key} → ${target.branch}` },
    async (): Promise<GitOutcome> => {
      if (target.action === 'switch') return switchBranch(root, target.branch);
      if (target.action === 'track' && target.remoteRef) {
        return trackRemoteBranch(root, target.branch, target.remoteRef);
      }
      return createBranch(root, target.branch, config.baseBranch || undefined);
    },
  );

  if (outcome.ok) {
    void vscode.window.showInformationMessage(`CodeBrain: ${outcome.message}`);
  } else {
    void vscode.window.showErrorMessage(`CodeBrain could not change branch — ${outcome.message}`);
  }
  return outcome;
}

/** Fetch remotes so branches a teammate just pushed appear on the cards. */
export async function fetchBranches(repository: RepositoryState): Promise<void> {
  if (!repository.root || !repository.isRepository) return;
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'CodeBrain: fetching branches…' },
    () => fetchRemotes(repository.root as string),
  );
  if (!outcome.ok) {
    void vscode.window.showWarningMessage(`CodeBrain: ${outcome.message}`);
  }
}

/**
 * Move an issue through its workflow.
 *
 * Only reachable while `codebrain.atlassian.allowWrite` is on — the same switch
 * that decides whether agents may change Jira, so the board never becomes a
 * quieter way around it. A transition Jira gates behind a screen is reported as
 * such instead of failing with a field-validation dump.
 */
export async function transitionIssue(
  issue: BoardIssue,
  atlassian: AtlassianIntegration,
): Promise<boolean> {
  if (!atlassian.writeAllowed()) {
    const choice = await vscode.window.showWarningMessage(
      'Moving an issue changes Jira. Turn on "CodeBrain › Atlassian: Allow Write" to enable it.',
      'Open setting',
    );
    if (choice === 'Open setting') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'codebrain.atlassian.allowWrite',
      );
    }
    return false;
  }

  const { connections } = await atlassian.status();
  if (!connections.jira) return false;
  const client = new AtlassianClient({ connections });

  let transitions;
  try {
    const response = await client.jiraTransitions(issue.key);
    transitions = (response.transitions ?? []).filter((transition) => transition.id);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `CodeBrain could not read the transitions for ${issue.key} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  if (transitions.length === 0) {
    void vscode.window.showInformationMessage(
      `CodeBrain: ${issue.key} has no transition available to you from ${issue.status}.`,
    );
    return false;
  }

  const picked = await vscode.window.showQuickPick(
    transitions.map((transition) => ({
      label: transition.name ?? transition.to?.name ?? 'Transition',
      description: transition.to?.name ? `→ ${transition.to.name}` : undefined,
      detail: transition.hasScreen
        ? 'Jira asks for extra fields on this transition; it may be rejected here.'
        : undefined,
      id: transition.id as string,
    })),
    {
      title: `${issue.key} — currently ${issue.status}`,
      placeHolder: 'Move this issue to…',
    },
  );
  if (!picked) return false;

  try {
    await client.jiraTransition(issue.key, picked.id);
    void vscode.window.showInformationMessage(
      `CodeBrain: ${issue.key} moved to ${picked.description?.replace('→ ', '') ?? picked.label}.`,
    );
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `CodeBrain could not move ${issue.key} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
