import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { collectGitReviewContext } from './gitContext';
import { buildImpactMarkdown, ImpactAnalysisService } from './impact';
import { IndexFreshness } from './indexFreshness';
import { detectResponseLanguage } from './language';
import {
  AFFECTED_TESTS_TOOL,
  EXPLORE_SYMBOL_TOOL,
  IMPACT_TOOL,
  REVIEW_PLAN_TOOL,
} from './lmToolNames';
import { buildReviewPlan, renderPlanMarkdown } from './reviewPlan';
import { codeBrainEnvironment, CodeBrainRuntime, runCodeBrain } from './runtime';
import { findIndexedRoot, getWorkspaceFolder, projectFolder } from './workspace';

interface ProjectInput {
  projectPath?: string;
}

interface FilesInput extends ProjectInput {
  files?: string[];
}

interface ExploreInput extends ProjectInput {
  query?: string;
  maxFiles?: number;
}

function text(value: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

/**
 * The indexed project a tool call is about, or guidance when there is none.
 *
 * A missing index is an expected condition, so it comes back as a normal
 * result telling the agent what to do — a thrown error teaches an agent to
 * stop calling the tool altogether. A `projectPath` outside the open
 * workspace is refused the same way: the tools only answer for code the
 * developer has open.
 */
export function resolveToolProject(
  input: ProjectInput,
  workspaceRoots: readonly string[],
  fallbackRoot: string | undefined,
): { root: string } | { guidance: string } {
  const requested = input.projectPath?.trim();
  if (requested) {
    const absolute = resolve(requested);
    const boundary = workspaceRoots.find(
      (root) => absolute === resolve(root) || absolute.startsWith(`${resolve(root)}${sep}`),
    );
    if (!boundary) {
      return { guidance: `${requested} is not inside the open VS Code workspace, so CodeBrain cannot answer for it.` };
    }
    const root = findIndexedRoot(absolute, boundary);
    return root
      ? { root }
      : { guidance: `${requested} has no CodeBrain index (.codegraph/). The user can run "CodeBrain: Index This Folder" to enable it; use your other tools meanwhile.` };
  }
  if (!fallbackRoot) {
    return { guidance: 'No workspace folder is open, so CodeBrain has no project to answer for.' };
  }
  const root = findIndexedRoot(fallbackRoot, fallbackRoot);
  return root
    ? { root }
    : { guidance: 'This workspace has no CodeBrain index (.codegraph/) yet. The user can run "CodeBrain: Initialize Workspace" to enable it; use your other tools meanwhile.' };
}

/** Project-relative, forward-slash paths; anything outside the project is dropped. */
export function normalizeToolFiles(root: string, files: readonly unknown[] | undefined): string[] {
  const kept = new Set<string>();
  for (const file of files ?? []) {
    if (typeof file !== 'string' || !file.trim()) continue;
    const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
    const relativePath = relative(root, absolute);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      continue;
    }
    kept.add(relativePath.replaceAll('\\', '/'));
  }
  return [...kept];
}

function currentProject(input: ProjectInput): { root: string } | { guidance: string } {
  return resolveToolProject(
    input,
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    getWorkspaceFolder()?.uri.fsPath,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * CodeBrain as a context provider for other agents in VS Code — Copilot's
 * agent mode, Claude Code, anything that consumes `vscode.lm.tools`.
 *
 * Three narrow tools: what a change breaks, which tests to run, and the source
 * of named symbols. Each answers in one call with text the agent can use
 * as-is.
 */
export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  runtime: CodeBrainRuntime,
  freshness: IndexFreshness,
  analysis: ImpactAnalysisService,
): void {
  if (typeof vscode.lm?.registerTool !== 'function') {
    return;
  }

  const impactTool: vscode.LanguageModelTool<FilesInput> = {
    prepareInvocation(options) {
      const files = options.input.files?.length;
      return {
        invocationMessage: files
          ? `CodeBrain: measuring the impact of ${files} file(s)…`
          : 'CodeBrain: measuring the impact of the working-tree changes…',
      };
    },
    async invoke(options, token) {
      const project = currentProject(options.input);
      if ('guidance' in project) return text(project.guidance);
      const folder = projectFolder(project.root);
      const files = normalizeToolFiles(project.root, options.input.files);
      try {
        const result = await analysis.analyze(folder, token, undefined, files);
        return text(buildImpactMarkdown(result, detectResponseLanguage('', vscode.env.language).code));
      } catch (error) {
        return text(`CodeBrain could not measure the impact: ${errorText(error)}`);
      }
    },
  };

  const affectedTestsTool: vscode.LanguageModelTool<FilesInput> = {
    prepareInvocation() {
      return { invocationMessage: 'CodeBrain: finding the affected tests…' };
    },
    async invoke(options, token) {
      const project = currentProject(options.input);
      if ('guidance' in project) return text(project.guidance);
      let files = normalizeToolFiles(project.root, options.input.files);
      if (files.length === 0) {
        files = (await collectGitReviewContext(project.root, 20_000)).changedFiles;
      }
      if (files.length === 0) {
        return text('There are no changed files in the working tree. Pass "files" to ask about specific files.');
      }
      try {
        await freshness.ensureFresh(projectFolder(project.root), token);
        const result = await analysis.affected(project.root, files, token);
        const lines = [
          `Changed files (${files.length}): ${files.join(', ')}`,
          '',
          result.affectedTests.length
            ? `Affected test files (${result.affectedTests.length}) — run these instead of the full suite:\n${result.affectedTests.map((test) => `- ${test}`).join('\n')}`
            : 'No indexed test file depends on these files. Tests that do not import the code (end-to-end, black-box) are not detected.',
          '',
          `Dependent files traversed: ${result.totalDependentsTraversed}`,
        ];
        return text(lines.join('\n'));
      } catch (error) {
        return text(`CodeBrain could not find the affected tests: ${errorText(error)}`);
      }
    },
  };

  const exploreTool: vscode.LanguageModelTool<ExploreInput> = {
    prepareInvocation(options) {
      return { invocationMessage: `CodeBrain: exploring ${options.input.query ?? 'the code graph'}…` };
    },
    async invoke(options, token) {
      const project = currentProject(options.input);
      if ('guidance' in project) return text(project.guidance);
      const query = options.input.query?.trim();
      if (!query) {
        return text('Pass "query": the symbol, qualified (Class.method) or file names to look up.');
      }
      const maxFiles =
        typeof options.input.maxFiles === 'number' && Number.isFinite(options.input.maxFiles)
          ? Math.max(1, Math.min(40, Math.round(options.input.maxFiles)))
          : 12;
      try {
        await freshness.ensureFresh(projectFolder(project.root), token);
        const result = await runCodeBrain(
          runtime,
          ['explore', query, '--path', project.root, '--max-files', String(maxFiles)],
          { cwd: project.root, env: codeBrainEnvironment(), token },
        );
        if (result.code !== 0) {
          return text(`CodeBrain explore failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
        }
        return text(result.stdout.trim() || `Nothing in the index matched "${query}".`);
      } catch (error) {
        return text(`CodeBrain explore failed: ${errorText(error)}`);
      }
    },
  };

  const reviewPlanTool: vscode.LanguageModelTool<ProjectInput> = {
    prepareInvocation() {
      return { invocationMessage: 'CodeBrain: planning the review of the working-tree changes…' };
    },
    async invoke(options) {
      const project = currentProject(options.input);
      if ('guidance' in project) return text(project.guidance);
      try {
        const budget = vscode.workspace.getConfiguration('codebrain').get<number>('chat.maxDiffCharacters', 120_000);
        let git = await collectGitReviewContext(project.root, budget);
        if (git.truncated) git = await collectGitReviewContext(project.root, Math.min(budget * 8, 1_500_000));
        if (!git.isRepository || git.changedFiles.length === 0) {
          return text('There are no changed files in the working tree to plan a review for.');
        }
        return text(renderPlanMarkdown(buildReviewPlan(git.changedFiles, git.diff, budget)));
      } catch (error) {
        return text(`CodeBrain could not plan the review: ${errorText(error)}`);
      }
    },
  };

  context.subscriptions.push(
    vscode.lm.registerTool(REVIEW_PLAN_TOOL, reviewPlanTool),
    vscode.lm.registerTool(IMPACT_TOOL, impactTool),
    vscode.lm.registerTool(AFFECTED_TESTS_TOOL, affectedTestsTool),
    vscode.lm.registerTool(EXPLORE_SYMBOL_TOOL, exploreTool),
  );
}
