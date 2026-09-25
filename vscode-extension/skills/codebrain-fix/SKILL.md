---
name: codebrain-fix
description: Fix a bug end to end — read the Jira bug (description, comments, screenshots), trace the failing path through the CodeBrain code graph to the root cause, reproduce it with a failing test, apply the smallest safe fix, and prove it with the test turning green. Load when the user reports a bug, error, crash, stack trace or wrong behavior, or hands over a Jira bug key.
argument-hint: "[bug description, error message, or Jira key]"
user-invocable: true
---

# CodeBrain Fix

Find the real root cause, prove it with a failing test, fix it with the smallest safe change, and prove the fix.

## 1. Collect the evidence

1. Jira key in the request or the branch name → call `codebrain_task_context` with `key`. The reproduction steps, environment and the agreed expected behavior are usually in the comments. If it mentions screenshots, call `jira_get_issue_images` and look at them.
2. Note the symptom, the trigger, expected vs actual behavior, and any stack trace or log line — these name the first symbols to explore.

## 2. Trace to the root cause

Call `codegraph_explore` with the symbols from the stack trace / ticket plus the entry point of the failing workflow. Follow the call path to the first place where an assumption breaks (null/undefined, wrong branch, off-by-one, stale state, async ordering, missing validation, swallowed error). Explore again with narrower names rather than grepping. Separate what the evidence shows from what you infer.

State the root cause in one or two sentences with `file:line` evidence before changing anything. If two causes are plausible, say which evidence would tell them apart.

## 3. Reproduce — red

Write a focused regression test that fails for the reported reason, and run it to confirm it fails. If the bug cannot be reproduced in a test (environment, timing, external system), explain why and describe the manual reproduction instead.

## 4. Fix — green

- Apply the smallest change that fixes the root cause, not just the symptom. Follow the surrounding code's conventions.
- Check the blast radius from `codegraph_explore`: every other path through the changed function must still hold.
- Run the new test (now green) and the affected existing tests. Check diagnostics for the touched files. Up to two fix rounds, then report what still fails.
- Self-review with `codegraph_review` (`base: "HEAD"`).

## 5. Report

In the user's language: root cause, the fix, the test that proves it (red → green), other paths checked, residual risk, and a rollback note. Draft — do not post — a Jira comment; only call `jira_add_comment` / `jira_transition_issue` if the user asks and write access is enabled. Never commit or push unless asked.

If `codebrain_task_context` is not available (the CodeBrain Atlassian server is not registered for this agent, or Jira is not configured), ask the user to paste the ticket's description and acceptance criteria, and continue from the code.
