---
name: codebrain-implement
description: Implement a feature or change request end to end — read the Jira ticket and Confluence spec, locate where the change plugs in with the CodeBrain code graph, agree a plan with the user, edit the code, verify with diagnostics and the affected tests, then self-review. Load when the user asks to implement, build, add, or change behavior, or hands over a Jira story/task key.
argument-hint: "[feature request or Jira key]"
user-invocable: true
---

# CodeBrain Implement

Deliver a working, tested change that satisfies the request and its acceptance criteria, with the smallest footprint that fits the existing design.

## 1. Understand the requirement

1. Find the ticket: a Jira key in the request, else in the current branch name (`git branch --show-current`). Call `codebrain_task_context` with `key` (or with `query` when there is only a description). It returns the issue, comments (the final decision usually lives there), **extracted acceptance criteria**, related Confluence spec pages, and the code names to explore.
2. If there is no ticket and no clear acceptance criteria, write down the criteria you will implement and confirm them with the user before editing.

## 2. Locate where the change plugs in

Call `codegraph_explore` with the names from the ticket and the request, plus the entry point and the layer you expect to change. Use its call paths and blast radius to find: the function(s) to change, the contracts they expose, who depends on them, and the tests that already cover them. Explore again with narrower names rather than grepping. Treat returned source as already read — it is current and line-numbered, so you can edit from it directly.

## 3. Plan — and stop for approval

Present a short plan before touching any file:

| Step | File / symbol | Change | Why (AC #) |
|---|---|---|---|

plus the **test plan** (new and existing tests), **risks / blast radius** (callers outside the change, public contracts, persistence, auth, concurrency), and **open questions**. Wait for the user to approve or adjust. Skip the wait only if the user explicitly said to proceed without asking.

## 4. Implement

- Follow the conventions of the surrounding code (naming, error handling, comment density, test style).
- Change the minimum set of files the plan named; if you discover the plan was wrong, say so and re-plan instead of drifting.
- Add or update tests for every acceptance criterion and every edge case you handled.

## 5. Verify

1. Check compiler/linter diagnostics for the files you touched and fix them.
2. Run the affected tests (the tests `codegraph_explore` / `codegraph_review` associated with the changed symbols, or the project's test command scoped to them). Fix failures — up to two rounds, then report what still fails and why instead of looping.
3. Self-review: call `codegraph_review` with `base: "HEAD"` and resolve anything it flags (changed signatures with callers outside the diff, removed exports still in use, changed code no test reaches).

## 6. Report and hand off

Summarize in the user's language: what changed (file by file), how each acceptance criterion is satisfied (with the test that proves it), what was verified, and what remains. Draft — do not post — a Jira comment summarizing the change. Only call a Jira/Confluence write tool (`jira_add_comment`, `jira_transition_issue`) if the user asks and write access is enabled. Never commit, push, or open a PR unless asked.

If `codebrain_task_context` is not available (the CodeBrain Atlassian server is not registered for this agent, or Jira is not configured), ask the user to paste the ticket's description and acceptance criteria, and continue from the code.
