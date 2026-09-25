---
name: codebrain-review
description: Review a change set against the code graph and its ticket — breaking changes, callers outside the diff, correctness and boundary safety, untested code, and whether every Jira acceptance criterion is actually implemented and tested. Load when the user asks to review changes, a commit, a branch or a PR, or asks whether a change is ready or satisfies its ticket.
argument-hint: "[scope: uncommitted, a commit, or a base branch; optional Jira key]"
user-invocable: true
---

# CodeBrain Review

A conservative, evidence-based review. Review only — do not edit code unless the user separately asks for fixes.

## 1. Gather context (before any Read or grep)

1. **Graph review.** Call `codegraph_review` once. Pass `base: "HEAD"` for uncommitted changes, or the PR's base branch (e.g. `"origin/main"`) for a branch — `base` is what turns on breaking-change detection. Its findings list changed signatures, removed exports still in use, callers outside the diff, and changed code no test reaches, each with `file:line`.
2. **Ticket.** Jira key in the request, the branch name, or the commit messages → call `codebrain_task_context` with `key` to get the acceptance criteria and spec.
3. **Drill down.** For each symbol a finding names, call `codegraph_explore` with that name to get its source and call paths. Do not grep for callers of a changed function — the review already has them.

## 2. Inspect every changed hunk

Check: null/undefined and boundary validation; branching, off-by-one and state transitions; async ordering, concurrency and cleanup; error propagation; security and data exposure; persistence and caching; naming, typing and duplication against the surrounding conventions; whether changed assumptions still hold along every affected call path. Treat shared contracts, auth, persistence, migrations, concurrency, lifecycle and high fan-out code as high risk until tests prove otherwise. Only report issues the evidence supports.

## 3. Report

In the user's language:

- **Verdict** — Critical / High / Medium / Low risk, one sentence why.
- **Findings** — by severity; each with category, `file:line`, consequence, affected workflow, and a concrete recommendation. Say "No blocking findings" when that is true.
- **Acceptance criteria coverage** — only when a ticket was loaded: a table of each criterion → implementing code (`file:line`) → test that proves it → Met / Partial / Missing.
- **Blast radius** — callers and workflows outside the diff that the change reaches, with a Mermaid flowchart when it clarifies.
- **Regression and test matrix** — scenario, affected symbol, risk, required test.
- **Release recommendation**, then **Evidence and limits** (facts vs inference; say when the graph has no test evidence — zero detected tests is not zero risk).

Offer — do not perform — posting the summary as a Jira comment; only call `jira_add_comment` if the user asks and write access is enabled.

If `codebrain_task_context` is not available (the CodeBrain Atlassian server is not registered for this agent, or Jira is not configured), ask the user to paste the ticket's description and acceptance criteria, and continue from the code.
