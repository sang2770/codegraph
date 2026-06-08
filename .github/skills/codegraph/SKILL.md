---
name: codegraph
description: Use CodeGraph MCP tools for code exploration, search, callers/callees, impact analysis, file lookup, and index freshness checks in VS Code.
---

# CodeGraph

Use this skill when the task benefits from indexed code structure, relationships, or impact analysis.

## Workflow

- Start with `codegraph_status` when freshness matters or results look stale.
- Use `codegraph_explore` first for architecture, execution-flow, debugging, and "how does this work" questions.
- Use `codegraph_search` to locate symbols, files, routes, or likely entry points.
- Use `codegraph_callers` and `codegraph_callees` to inspect direct relationships around a symbol.
- Use `codegraph_impact` before refactors, risky edits, public API changes, or behavior changes.
- Use `codegraph_node` for one precise symbol/file node and `codegraph_files` for indexed file discovery.
- Prefer CodeGraph evidence before broad manual file reading, then read exact files when implementation details matter.

## Tool Surface

- `codegraph_explore`
- `codegraph_search`
- `codegraph_callers`
- `codegraph_callees`
- `codegraph_impact`
- `codegraph_node`
- `codegraph_files`
- `codegraph_status`
