/**
 * Names of the language-model tools this extension registers
 * (`contributes.languageModelTools` in package.json).
 *
 * Kept in a module of their own, free of `vscode`, so the chat participant can
 * exclude them when it looks for the graph server's explore tool.
 */
export const IMPACT_TOOL = 'codebrain_get_impact';
export const AFFECTED_TESTS_TOOL = 'codebrain_get_affected_tests';
export const EXPLORE_SYMBOL_TOOL = 'codebrain_explore_symbol';
export const REVIEW_PLAN_TOOL = 'codebrain_get_review_plan';

export const OWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  IMPACT_TOOL,
  AFFECTED_TESTS_TOOL,
  EXPLORE_SYMBOL_TOOL,
  REVIEW_PLAN_TOOL,
]);
