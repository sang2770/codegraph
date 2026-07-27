---
name: codebrain
description: Use CodeBrain for fast, token-efficient code understanding, workflow explanations, dependency tracing, blast-radius analysis, and high-signal code review. Load when a request asks what code does, how a workflow reaches another component, what a change affects, or whether a change is risky.
argument-hint: "[question, symbol, file, workflow, or change to analyze]"
user-invocable: true
---

# CodeBrain

Use the `codegraph_explore` MCP tool before grep, repository-wide search, or opening a chain of source files when the project has a `.codegraph/` index.

One focused query should name the question, relevant symbols, file paths, or workflow endpoints. Treat returned line-numbered source as already read. It also includes call paths and a blast-radius summary.

For explanations:

1. State what the code is for and why it exists.
2. Trace the workflow through concrete functions and files.
3. Separate control flow, data flow, side effects, and failure paths.
4. Include a compact Mermaid chart when it improves the explanation.
5. Identify uncertainties instead of inventing missing edges.

For reviews:

1. Inspect the diff or selected code and query changed symbols/files with `codegraph_explore`.
2. Use callers, callees, and blast radius to assess regressions.
3. Report findings by severity with file/line evidence, consequence, and recommendation.
4. Treat changes to shared contracts, persistence, authentication, concurrency, lifecycle, or broad fan-out code as high risk until tests prove otherwise.
5. Review only. Do not edit code unless the user separately asks for a fix.

If no `.codegraph/` index exists, explain that the workspace must be initialized and use normal editor tools for the current request.
