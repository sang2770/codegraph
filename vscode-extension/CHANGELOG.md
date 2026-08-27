# Changelog

All notable changes to the CodeBrain VS Code extension are documented here.

## [Unreleased]

### New Features

- CodeBrain now has a **Jira Board** of its own. A new icon in the Activity Bar lists the tickets you care about, and **CodeBrain: Open Jira Board** opens a wide version with charts in an editor tab. It runs on the Jira credentials you already configured, so there is nothing new to log into.
- Filter the board the way you think about work: whose issues (assigned to you, reported by you, watched, everyone), which columns (To do, In progress, Done), by deadline (overdue, due today, due this week, no due date), by exact status, by project, to open sprints only, and a search box that narrows the loaded issues by key, summary, assignee, label or component as you type. Only the filters that change the query re-ask Jira; the rest are instant. Your choices are remembered per workspace.
- The board warns you before something rots: tiles count what is **overdue**, **due soon**, **stale** (in progress but untouched), **unassigned**, or in progress with **no due date**, and clicking a tile shows only those issues. Each card carries its own warnings and a coloured edge for the most serious one. Finished issues are never flagged. Tune the thresholds with `codebrain.jira.dueSoonDays` and `codebrain.jira.staleDays`.
- The full board adds statistics over exactly what is on screen — a progress donut with the completion rate, a deadline distribution, the workload per person, and a breakdown by status — so changing a filter changes the charts with it.
- One click on a card puts you on the right branch. CodeBrain switches to a local branch that already carries the issue key, creates a local branch tracking a teammate's remote one, or suggests a name (`bugfix/TPLD-958-fix-chart-lag` by default, with accented summaries turned into readable ASCII) and lets you edit it before creating it. Several branches carrying the same key are offered as a list instead of guessed at, uncommitted changes are pointed out before a switch carries them along, and **Fetch branches** picks up what was just pushed. The naming is yours via `codebrain.jira.branchTemplate`, and new branches can always start from a fixed base with `codebrain.jira.baseBranch`.
- The reverse direction works without opening anything: the status bar shows the ticket behind your current branch with its status, and goes amber when that ticket is overdue. A branch only counts as a ticket when its project is one your board actually loaded, so `chore/node-22` is not reported as NODE-22. Turn it off with `codebrain.jira.statusBar`.
- Also on each card: **Ask CodeBrain**, which opens Chat with the ticket as the question, and **Copy key** for your commit message. With **CodeBrain › Atlassian: Allow Write** on, a **Move** action transitions the issue — the same switch that governs agents, so the board is read-only until you decide otherwise.
- Added **CodeBrain: Check Out Branch for a Jira Issue** and **CodeBrain: Open the Jira Issue for This Branch**, both available from the Command Palette, and the first also from the Source Control menu.
- CodeBrain now tells you what it just gained. The first time it starts after an update, a **What's new** page opens with everything released since the version you were on — skip three releases and you get all three, not only the newest. It never appears on a fresh install, never twice for the same version, and **CodeBrain: What's New** opens it on demand. Turn it off with `codebrain.releaseNotes.showOnUpdate`.

- The Source Control title bar has a new **sparkle button** that writes your commit message for you. It describes the staged changes — or the whole working tree when nothing is staged — and drops the message straight into the commit box, with an **Undo** offered if it replaced something you had typed.
- Commit messages follow **your** convention. **CodeBrain: Choose Commit Message Format** offers Conventional Commits, an issue-key style (`TPLD-958: Fix Chart lag issue` with a nested detail list), or a plain summary — each shown as a real example rather than a name. Set `codebrain.commit.language` to have them written in another language.
- The prompt now includes the current branch name and the last few commit subjects, so a format can take the issue key straight from the branch and match the style already in your history. A branch with no issue key gets no prefix rather than an invented one.
- For anything the built-in formats do not cover, **CodeBrain: Customize Commit Message Template** creates `.codebrain/commit-template.md`, pre-filled with the format you are already using. Whatever you put there replaces the built-in one, and committing the file gives the whole team the same convention.
- CodeBrain is no longer Copilot-only. Run **CodeBrain: Install CodeBrain for Agents (Claude, Codex, Gemini…)** to give Claude Code, Codex CLI, Gemini CLI, Antigravity, and GitHub Copilot the same MCP server the extension gives Copilot, then restart that agent. Each entry runs the runtime bundled with the extension, so nothing has to be installed separately, and it is never pinned to one workspace — the agent starts the server wherever you are working and CodeBrain answers from the nearest indexed project. **CodeBrain: Uninstall CodeBrain from Agents** removes everything again.
- The same command also installs the **CodeBrain skill** — the guidance that tells an agent when to reach for the graph instead of searching the repository. It goes in through each agent's own mechanism where one exists (a skill for Claude Code, a `/codebrain` prompt for Codex CLI, a `/codebrain` command for Gemini CLI) and, only where none exists, as a clearly marked section in the agent's instructions file (Antigravity, and `.github/copilot-instructions.md` for Copilot outside VS Code). Anything you wrote around that section is preserved, and uninstalling removes only the marked part.
- Installing now asks where things should go: **globally**, so every project on the machine sees them, or **for the current workspace only**. Agents with no configuration at the chosen scope are offered at the other one instead of being written somewhere they would never read — Codex CLI and Antigravity are global-only, and Copilot's instructions file belongs to a repository. Uninstalling sweeps both scopes.
- **Gemini CLI** is now offered alongside Claude Code, Codex CLI, and Antigravity when registering either MCP server.
- CodeBrain now ships a second MCP server for **Jira and Confluence (Collab)**, so an agent can look up the ticket behind a branch, the spec behind a design decision, or the discussion that explains why the code looks the way it does — without leaving the task. It reads Confluence (search, and a full page) and Jira (search with free text or JQL, a full issue with its comment thread, and the comments on their own).
- Screenshots and diagrams come back as **actual images**. `jira_get_issue_images` and `confluence_get_page_images` return the pictures attached to an issue or a page inline, so an agent can look at the crash or the architecture diagram instead of working from the text around it. Uploads that arrive with a vague file type are still recognised by their filename, and anything too large to send is named rather than silently dropped.
- Agents can **write back to Jira and Confluence** when you let them. Turn on **CodeBrain › Atlassian: Allow Write** and they can comment on an issue, move it through its workflow, assign it, and create, update or comment on a page — enough to record what they found without you copying it over by hand. It is off by default, and while it is off those tools are not offered to any agent at all, so the server can only read. Every change is reported back with the new status, the new page version and a direct link; page updates add to the end by default instead of replacing what is there; and an edit made by someone else in the meantime is refused rather than overwritten. The switch applies to every agent sharing the credentials, and can be flipped back at any time.
- One setup covers every agent. Run **CodeBrain: Configure Atlassian (Collab + Jira)** to enter the base URLs and personal access tokens; GitHub Copilot picks the server up immediately, and **CodeBrain: Register Atlassian MCP with Agents** adds it to Claude Code, Codex CLI, Gemini CLI, and Antigravity. Both Server/Data Center (personal access tokens) and Cloud (API token plus account email) are supported.
- Tokens are stored in the OS keychain and mirrored once to a private, owner-only credentials file — the only way agents outside VS Code can read them. The config file CodeBrain writes for each agent contains just the command to run, so a committed `.mcp.json` never leaks a token. **CodeBrain: Clear Atlassian Credentials** and **CodeBrain: Unregister Atlassian MCP from Agents** undo each half independently.
- Added **CodeBrain: Test Atlassian Connection**, which makes one authenticated call per configured product and reports exactly what failed — a rejected token, a missing context path, an unreachable host behind a private certificate authority.
- Agent configs and installed skills are repaired automatically after an extension update, so an upgrade no longer silently breaks the server — or leaves an agent following the previous version's guidance — for Claude Code, Codex, Gemini CLI, or Antigravity.
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
