---
name: codebrain-explain
description: Explain how a feature or workflow works end to end — business purpose first, then the concrete code path with files, lines and diagrams — grounded in the CodeBrain code graph and, when a Jira issue or Confluence spec is involved, in that ticket and spec. Load when the user asks what code does, how X reaches Y, why something was built this way, or to explain a ticket's feature.
argument-hint: "[question, symbol, feature, or Jira key]"
user-invocable: true
---

# CodeBrain Explain

Explain a workflow so a developer new to it can follow the business intent and the exact code that implements it. Read-only: do not edit files.

## 1. Gather context (before any Read or grep)

1. **Ticket or spec involved?** If the request, the current branch name, or an attached file mentions a Jira key (`ABC-1234`) — or the user asks "why was this built this way" — call `codebrain_task_context` (CodeBrain Atlassian MCP server) with `key`, or with `query` for a free-text spec lookup. One call returns the issue, its comments, extracted acceptance criteria, the related Confluence pages, and the code names to explore. Treat it as already read.
2. **Code.** Call `codegraph_explore` with a bag of the symbol names that span the flow — the entry point, the end point, and any names the ticket or the user mentioned (`OrderController.submit PaymentGateway.charge`). Its output is verbatim, line-numbered source plus the call path between those symbols; treat it as already read. If a hop is missing, call `codegraph_explore` again with the more specific names it surfaced — not Read or grep.

## 2. Write the explanation

Answer in the user's language. Use this structure:

- **Executive summary** — two or three sentences.
- **Business workflow** — numbered business steps; for each, the implementing `file:line` and symbol.
- **Code flow** — a compact code-like walkthrough mapping each step to the function that performs it.
- **Diagrams** — one Mermaid `flowchart` of the main path and one `sequenceDiagram` of execution order, using only names the evidence supports.
- **Data, state and side effects**, then **Failure and edge paths**.
- **Spec vs code** — only when a ticket or spec was loaded: where the implementation matches the acceptance criteria / spec, and any drift, each with evidence.
- **Evidence and limits** — separate indexed facts from inference; name any hop the graph could not connect (dynamic dispatch, reflection, configuration) instead of inventing it.

Say "entry point", "next step", "downstream dependency" rather than caller/callee jargon. Keep identifiers and paths verbatim.

If `codebrain_task_context` is not available (the CodeBrain Atlassian server is not registered for this agent, or Jira is not configured), ask the user to paste the ticket's description and acceptance criteria, and continue from the code.
