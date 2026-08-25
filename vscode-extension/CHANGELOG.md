# Changelog

All notable changes to the CodeBrain VS Code extension are documented here.

## [Unreleased]

### New Features

- CodeBrain now ships a second, read-only MCP server for **Jira and Confluence (Collab)**, so an agent can look up the ticket behind a branch, the spec behind a design decision, or the discussion that explains why the code looks the way it does — without leaving the task. It offers five tools: search Confluence, read a full page, search Jira with free text or JQL, read a full issue with its comment thread, and read just the comments. Nothing in the server can create, edit, or transition anything.
- One setup covers every agent. Run **CodeBrain: Configure Atlassian (Collab + Jira)** to enter the base URLs and personal access tokens; GitHub Copilot picks the server up immediately, and **CodeBrain: Register Atlassian MCP with Agents** adds it to Claude Code, Codex CLI, and Antigravity. Both Server/Data Center (personal access tokens) and Cloud (API token plus account email) are supported.
- Tokens are stored in the OS keychain and mirrored once to a private, owner-only credentials file — the only way agents outside VS Code can read them. The config file CodeBrain writes for each agent contains just the command to run, so a committed `.mcp.json` never leaks a token. **CodeBrain: Clear Atlassian Credentials** and **CodeBrain: Unregister Atlassian MCP from Agents** undo each half independently.
- Added **CodeBrain: Test Atlassian Connection**, which makes one authenticated call per configured product and reports exactly what failed — a rejected token, a missing context path, an unreachable host behind a private certificate authority.
- Agent configs registered with CodeBrain are repaired automatically after an extension update, so an upgrade no longer silently breaks the server for Claude Code, Codex, or Antigravity.
- Tools for a product you did not configure are never shown to the agent, and a page body or issue description that has to be shortened says so explicitly instead of just ending.

### Fixes

- On Linux and macOS, CodeBrain no longer needs you to grant its runtime execute permission by hand. Some hosts — VS Code forks, OpenVSX installs, an extensions folder that was copied or unzipped manually — unpack the extension without unix file permissions, and every command then failed with "permission denied" until you ran `chmod +x` yourself. CodeBrain now restores the execute bit on its own at startup and notes it in the output channel. If the extension folder is read-only or owned by another user, the error says exactly which command to run instead of just reporting a failed command.

## [1.2.0] - 2026-08-11

### New Features

- Each file now shows its blast radius as a CodeLens above line 1 — how many files depend on it and how many tests are affected — so the risk of an edit is visible while you make it, without running a command.
- Added **CodeBrain: Run Affected Tests**, available from the CodeLens, the Source Control title bar, and the impact panel. CodeBrain detects your project's test runner (Vitest, Jest, Playwright, Mocha, pytest, go test, RSpec, PHPUnit, Cargo, Maven, Gradle, dotnet) and shows the command for confirmation before running it. Set `codebrain.tests.command` to skip detection.
- Chat now remembers the conversation. Follow-ups such as "what about the other one?" resolve against earlier turns, and a thread stays in the language it started in instead of switching when a short follow-up carries no language signal.
- Review findings survive a window reload, and can now be dismissed as false positives from the lightbulb menu or the comment thread. A dismissed finding stays hidden in later reviews. Restore them with **CodeBrain: Restore Dismissed Review Findings**.
- You can reply to a review finding in its comment thread to ask CodeBrain about it, and use the lightbulb to explain a finding in chat.
- **CodeBrain: Show Index Status** now opens a panel instead of printing raw JSON. It shows files and symbols per language, warns when the last index run silently dropped files or left references unresolved, and lists workspace files that are missing from the index — the failure that used to make impact analysis quietly incomplete with no error.
- Added **CodeBrain: Choose Project** for monorepos with more than one indexed project, and **CodeBrain: Rebuild Index** for an index the runtime reports as partial or outdated.
- Indexing now reports live progress and can be cancelled.

### Fixes

- Token-saving figures are now measured instead of guessed. The chat footer previously multiplied the context size by a fixed constant, which made the reported saving a fixed ~85% regardless of the repository or the question. Both the footer and the dashboard now compare against the real on-disk size of the files CodeBrain drew evidence from, and say plainly when a comparison cannot be measured rather than showing a number. Stored totals from earlier versions are retired rather than mixed with measured ones.
- Impact analysis now detects when the dependency traversal stopped at `codebrain.impact.maxDepth` with more of the graph still reachable, and reports the dependent counts as a lower bound instead of presenting them as the full blast radius. Evidence confidence drops accordingly. Disable the check with `codebrain.impact.detectDepthTruncation`.
- Analyses no longer re-index before every question. CodeBrain now refreshes only when the workspace has actually changed since the last refresh, and reuses graph results for repeated questions until a file changes.
- Review findings no longer drift onto unrelated code after you edit a file. They re-anchor to the reviewed line's content, say when a finding moved, and admit when the reviewed line no longer exists rather than pointing confidently at the wrong place.
- A project whose index lives above the opened folder is no longer reported as uninitialized when the runtime can answer for it.
- MCP tool failures are now recorded in the CodeBrain output channel instead of being silently swallowed, so a permanently broken MCP connection no longer just looks like slowness.

## [0.3.3] - 2026-08-03

### Added

- Added project README context to `/explain` and `/review` so explanations and reviews can use documented terminology, intended behavior, and contracts.
- Added clearer impact analysis results with severity scoring, explainable signals, test coverage status, evidence confidence, and recommendations.
- Improved the workflow graph and Markdown impact report to show changed files, dependent workflows, and affected tests more clearly.

### Changed

- README content is now the user-facing installation and usage guide shown in the VS Code extension Details page.
- Development instructions remain available in `DEVELOPMENT.md` for contributors and are excluded from the packaged VSIX.

## [0.3.2]

### Added

- Added the user-facing CodeBrain workflow guide and extension feature documentation.
- Added interactive impact analysis, affected-test detection, workflow graph visualization, and local token-saving metrics.
