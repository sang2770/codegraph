# CodeBrain for VS Code

CodeBrain helps AI understand your codebase using a local semantic code graph, bypassing the need for tedious manual context gathering or repository-wide search loops. It integrates a native-accelerated runtime, Model Context Protocol (MCP) server, Agent Skill, custom Chat Participant, independent AI code review, change impact analyzer, affected test finder, and interactive visualization dashboard right inside VS Code.

---

## 🚀 Getting Started

### 1. Installation
CodeBrain is distributed as a platform-specific VS Code extension (`.vsix`) containing a bundled Node.js environment, the CodeBrain runtime, and a native Rust kernel. You do **not** need Node.js or any external CLI installed on your machine.

To install:
1. Open VS Code.
2. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS).
3. Run **Extensions: Install from VSIX...**
4. Choose the `.vsix` file matching your operating system and architecture:
   - `darwin-arm64`: macOS Apple Silicon
   - `darwin-x64`: macOS Intel
   - `linux-arm64` / `linux-x64`
   - `win32-arm64` / `win32-x64`
5. Reload VS Code when prompted.

### 2. Initializing Your Workspace
Before querying CodeBrain, you must index your repository:
1. Open your workspace folder in VS Code.
2. Run the command **CodeBrain: Initialize Workspace** from the Command Palette.
3. This creates a local `.codegraph/` directory in your workspace root.
4. Check the Status Bar for progress. Once indexing finishes, the status bar will show `CodeBrain: Ready`.

> [!NOTE]
> Initial indexing might take some time on large codebases. Subsequent updates are incremental and extremely fast.

---

## 🛠️ Main Features

### 💬 VS Code Chat Participant (`@codebrain`)
Interact directly with your codebase using the `@codebrain` participant. It automatically detects the language of your prompt (supporting English, Vietnamese, and others) and formats headings, explanations, and diagrams in that language.

- **`/explain`**: Explains the business workflow and maps each step to a concrete, developer-readable code flow.
  - *Example*: `@codebrain /explain How does the authentication middleware work?`
  - It generates a structured Markdown report with business steps, a pseudo-code walkthrough, and Mermaid diagrams of the execution path.
- **`/review`**: Reviews active changes or selection against codebase conventions and architecture.
  - *Example*: `@codebrain /review Review my current changes`
  - It analyzes Git diffs and call paths to return risk levels (Critical/High/Medium/Low), structural bugs, boundary cases, and release recommendations.
- **`/impact`**: Analyzes the blast radius of changes.
  - *Example*: `@codebrain /impact What is the impact of modifying refreshSession?`

- **`/fix`**: Analyzes a reported bug, traces the failure path and root cause, and proposes a safe solution with a focused validation plan. It is analysis-only and does not edit files.
  - *Example*: `@codebrain /fix Login returns 401 after the token refresh succeeds`

- **`/guide`**: Generates a user-facing Markdown guide for a feature, including prerequisites, permissions, numbered usage steps, examples, expected states, troubleshooting, and a validation checklist. The generated report can be previewed and exported as an `.md` file.
  - *Example*: `@codebrain /guide How do users configure automatic index refresh?`
  - Automatically identifies affected workflows and dependent code paths.

### ⚡ Blast Radius CodeLens
Every file shows its blast radius above line 1 — no command needed:

```text
⚡ CodeBrain: 23 dependents · 2 affected tests
🧪 Run 2 affected tests
```

Click the first lens to run a full impact analysis, or the second to run just those tests. Turn it off with `codebrain.codeLens.enabled`.

### 🧪 Run Affected Tests
CodeBrain finds which tests matter, then runs them. Available from the CodeLens, the Source Control title bar, the impact panel, or **CodeBrain: Run Affected Tests**.

It detects your project's runner — Vitest, Jest, Playwright, Mocha, pytest, `go test`, RSpec, PHPUnit, Cargo, Maven, Gradle, `dotnet test` — and **always shows the command for confirmation** before running it, because the detected runner can be wrong. Set `codebrain.tests.command` (with `${files}`) to skip detection.

### 🔍 Change Impact & Affected Tests
Analyze changes from tracked, staged, or untracked Git files (falling back to the active file if the repository is clean) using:
- Command: **CodeBrain: Analyze Change Impact**
- Chat: `@codebrain /impact`, `@codebrain /fix`, or `@codebrain /guide`

The engine will:
1. Traverse call graphs to find affected dependencies up to a configurable depth.
2. Locate affected test files (e.g., `.test.*`, `.spec.*`, `tests/`).
3. Classify risk levels based on fan-out, public contracts, and test coverage gaps.
4. Check whether the traversal stopped at its depth limit. If it did, the dependent counts are reported as a **lower bound** (`≥ N`) with a visible warning, instead of being presented as the full blast radius.

### ✨ Generate a Commit Message
Click the **sparkle icon** in the Source Control title bar and CodeBrain writes the commit message straight into the message box.

It describes your **staged** changes — exactly what the next commit will contain — and falls back to the whole working tree when nothing is staged yet. If the box already had text, the notification offers **Undo** to put it back.

**Your convention, not ours.** Run **CodeBrain: Choose Commit Message Format** (also in the Source Control `⋯` menu) and pick one — the picker shows a real example of each rather than a name to guess at:

| Format | Looks like |
| :--- | :--- |
| Conventional Commits | `feat(auth): add refresh tokens` |
| Issue key + summary | `TPLD-958: Fix Chart lag issue`, a blank line, then a nested `-` / `+` / `*` detail list |
| Plain summary | `Fix chart lag when the window is resized` |

Set `codebrain.commit.language` to write in another language — `Vietnamese`, for instance. Identifiers, paths and issue keys are left as they are.

The prompt also carries the **current branch name** and the last few commit subjects, so a format can take the issue key from `feature/TPLD-958-chart-lag` and match the style already in the repository. When the branch has no issue key, the prefix is dropped rather than invented.

**Need something none of those cover?** Pick **Custom template…** in the same list (or run **CodeBrain: Customize Commit Message Template**) to create `.codebrain/commit-template.md`, seeded with whichever format is active so you start from working text instead of a blank page. That file *replaces* the built-in format — a rule you delete stops being applied — and it is read from the repository root, so committing it gives your whole team the same convention. Delete it to go back to the picker. `codebrain.commit.templateFile` points somewhere else if you keep conventions in another file.

The message uses the model chosen with **CodeBrain: Choose AI Model**.

### 🧠 Independent AI Code Review
Run **CodeBrain: Review Changes** from the Source Control title menu or Command Palette for a review that is independent of Copilot Review.

The command combines the current Git diff with CodeGraph evidence and calls a model directly through the VS Code Language Model API. It produces a temporary Markdown report containing:

- Verdict and merge recommendation.
- Critical, high, medium, and low findings.
- File and line references when available.
- Affected workflows and graph evidence.
- Affected tests and missing test coverage.
- Inline diagnostics in the reviewed files and the Problems panel.

Findings persist across window reloads, and re-anchor to the reviewed line's content after you edit a file — telling you when a finding moved, and admitting when the reviewed line no longer exists rather than pointing at the wrong code.

**Disagreeing with a finding.** Use the lightbulb to *dismiss* a false positive (it stays hidden in future reviews too) or to *explain* it in chat. You can also reply directly in the finding's comment thread to ask CodeBrain about it. Restore everything with **CodeBrain: Restore Dismissed Review Findings**.

The report is also stored as the latest CodeBrain report and can be exported with **CodeBrain: Export Latest Report as Markdown**. This workflow does not read or depend on Copilot Review comments. The configured CodeBrain model is used by extension-owned AI commands; ChatParticipant requests continue using the model selected in VS Code Chat.

Use **CodeBrain: Choose AI Model** to select the model used by **CodeBrain: Review Changes** and future extension-owned AI commands. Leave the setting empty to use the first available provider model.

### 📊 Interactive Workflow Graph
Run **CodeBrain: Open Workflow Graph** to visualize the impact path:
```text
Changed Files ──> Dependents / Workflows ──> Affected Tests
```
- Click any node to open the corresponding source file and line.
- The interface displays the active engine (`Rust native` or `WASM fallback`).

### 📈 Context Cost Dashboard
See what the graph context cost versus reading the same files in full.
- Command: **CodeBrain: Token Savings Dashboard**
- Shows measured baselines, avoided file reads, and query latency.

**How the comparison is measured.** CodeBrain takes the files it actually drew evidence from, reads their real sizes on disk, and converts both sides at the same ratio (4 bytes ≈ 1 token). When no candidate file can be measured, it reports the saving as **unknown** rather than showing a number.

> [!TIP]
> All metrics are stored locally inside VS Code's workspace state. No telemetry or billing data is uploaded. These are context-size estimates, not model billing data.

### 🩺 Index Status & Coverage
**CodeBrain: Show Index Status** opens a panel showing:
- Files, symbols, and relationships indexed, broken down by language.
- **Tracked only** files — indexed for change detection but with no symbols extracted, so they cannot appear inside a call path.
- **Coverage gaps** — workspace files missing from the index. This matters: a source language the parsers do not support is simply absent from the graph, so any impact analysis that should have crossed it is incomplete with no error to tell you.
- Warnings when the last index run dropped files, left references unresolved, or was built by an older engine.

### 🗂️ Monorepo Support
When a workspace holds several indexed projects, **CodeBrain: Choose Project** pins which one CodeBrain answers for. By default it follows the nearest indexed project above whichever file is open.

### 🤖 Read-only CodeBrain Reviewer Agent
Use the custom agent **CodeBrain Reviewer** in VS Code Chat. It is granted CodeBrain-specific graph query tools without write or terminal permissions—ideal for secure, evidence-based code reviews and release assessments.

### 📄 Exportable Markdown Reports
Save generated reviews or explanations using the command **CodeBrain: Export Latest Report as Markdown**. Keep a lightweight record of complex analysis to review, share, or feed back to other AI models.

### 🔌 CodeBrain for Every Agent — MCP Server + Skill
Two things make CodeBrain useful to an agent: the **MCP server**, which gives it the graph tools, and the **skill**, which tells it when and how to use them. Inside VS Code, Copilot gets both from the extension itself. Every other agent reads its own files, so run **CodeBrain: Install CodeBrain for Agents (Claude, Codex, Gemini…)**, choose a scope, choose what to install, tick the agents you use, and restart them.

**MCP server**

| Agent | Global — every project | This workspace only |
| :--- | :--- | :--- |
| Claude Code | `~/.claude.json` | `<workspace>/.mcp.json` |
| Codex CLI | `~/.codex/config.toml` | — |
| Gemini CLI | `~/.gemini/settings.json` | `<workspace>/.gemini/settings.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` | — |

**Skill** — installed through each agent's own mechanism wherever it has one, because a skill or slash command is loaded only when it is relevant, while an instructions file is loaded into every single request:

| Agent | Mechanism | Global | This workspace only |
| :--- | :--- | :--- | :--- |
| Claude Code | skill | `~/.claude/skills/codebrain/SKILL.md` | `<workspace>/.claude/skills/codebrain/SKILL.md` |
| Codex CLI | prompt — run `/codebrain` | `~/.codex/prompts/codebrain.md` | — |
| Gemini CLI | command — run `/codebrain` | `~/.gemini/commands/codebrain.toml` | `<workspace>/.gemini/commands/codebrain.toml` |
| Antigravity | instructions section | `~/.gemini/GEMINI.md` | — |
| GitHub Copilot | instructions section | — | `<workspace>/.github/copilot-instructions.md` |

Every agent is given the same text — `skills/codebrain/SKILL.md`, the file Copilot already receives — so there is no second copy to drift. The instructions-file sections are wrapped in `<!-- CODEBRAIN_SKILL_START -->` / `<!-- CODEBRAIN_SKILL_END -->` markers: everything you wrote around them is preserved, and uninstalling takes out only the marked section. Copilot inside VS Code already has the skill packaged with the extension, so its entry here is what reaches Copilot everywhere else — github.com, the CLI, other editors.

**Which scope?** Global is usually what you want: the MCP entry carries no workspace path, so each agent starts the server in whatever folder you are working in and CodeBrain answers from the nearest indexed project — one installation covers every repository you open. Pick the workspace scope when it should travel with the repository (`.mcp.json` and the skill files are safe to commit — they hold no tokens) or when only this project should see it. Codex CLI and Antigravity have no project-scoped configuration at all, so they are only offered globally; Copilot's instructions file belongs to a repository, so it is only offered for the workspace.

Every MCP entry points at the extension's own bundled runtime, so no Node.js install, no `npm i -g`, and no PATH surprises when an agent is launched from a GUI. A repository with no `.codegraph/` yet simply reports that it is not indexed; run **CodeBrain: Initialize Workspace** there.

Extension updates move the bundled runtime's path and can change the skill text. CodeBrain rewrites what it already owns on the next activation — at whichever scope you installed it — so an agent keeps working across upgrades without you re-running anything. **CodeBrain: Uninstall CodeBrain from Agents** sweeps both scopes and both halves, so nothing is left behind.

### 📋 Jira Board with Branch Mapping
A **CodeBrain** icon in the Activity Bar opens a **Jira Board** that runs on the same credentials as the Atlassian MCP server — no second login. **CodeBrain: Open Jira Board** opens the wide version with charts in an editor tab.

**Filters, and what each one costs.** Chips pick who (*Mine*, *Reported*, *Watching*, *Everyone*) and the progress columns (*To do*, *In progress*, *Done*); a dropdown filters by deadline (overdue, today, this week, no due date); and there is a project box, an open-sprints toggle, a sort order, and a search box that filters the loaded issues by key, summary, assignee, label or component as you type. Only the filters that belong in the query re-ask Jira — the rest narrow what is already loaded, so they are instant. Your choices are remembered per workspace.

**Warnings, so nothing rots quietly.** Tiles above the board count what needs attention: **overdue**, **due soon** (within `codebrain.jira.dueSoonDays`), **stale** (in progress, untouched for `codebrain.jira.staleDays`), **unassigned**, and **in progress with no due date**. Click a tile to see only those issues. Warnings are never reported on a finished issue. Each card also shows its own warnings, and carries a coloured edge for the most severe one.

**Statistics.** The full board adds a progress donut with the completion rate, a deadline distribution, workload per assignee, and a breakdown by status — all over the issues currently on screen, so a filter changes the charts with it.

**Branch mapping.** Each card knows the branches that carry its issue key, and one click does the right thing:
- a local branch exists → switch to it (and CodeBrain asks first if uncommitted changes would be carried along);
- only a teammate's remote branch exists → create a local branch tracking it;
- neither → suggest a name from `codebrain.jira.branchTemplate` (default `{prefix}/{key}-{summary}`, so `TPLD-958` becomes `bugfix/TPLD-958-fix-chart-lag`) and let you edit it before it is created. Accented summaries become readable ASCII, and a name git would refuse is corrected before it is offered.

Several branches carrying the same key are offered as a list rather than guessed at. **CodeBrain: Check Out Branch for a Jira Issue** does the same thing from the Command Palette or the Source Control menu, and **Fetch branches** picks up what teammates just pushed.

**The reverse direction, passively.** The status bar shows the issue key read from the current branch with its status, going amber when that issue is overdue — click it to open the ticket. A branch key is only trusted when its project is one the board actually loaded, so `chore/node-22` is not reported as ticket NODE-22. Turn it off with `codebrain.jira.statusBar`.

Cards also offer **Ask CodeBrain**, which opens Chat with the ticket as the question, and **Copy key** for the commit message. With `codebrain.atlassian.allowWrite` on, a **Move** action transitions the issue — the same switch that governs agents, so the board is read-only until you say otherwise.

### 🔗 Jira & Confluence (Collab) Search for Every Agent
CodeBrain ships a second MCP server that lets an agent search your team's Confluence (Collab) and Jira from inside the task it is already working on — the ticket behind a branch name, the spec behind a design decision, the discussion that explains why the code looks the way it does.

Seven read tools: `confluence_search`, `confluence_get_page`, `confluence_get_page_images`, `jira_search`, `jira_get_issue`, `jira_get_comments`, `jira_get_issue_images`. Page bodies and issue descriptions come back in full, so the agent does not have to ask you to paste anything — and the image tools hand back the attached screenshots and diagrams as real images, so the agent can look at the crash instead of guessing from the prose around it.

**Writing back is opt-in.** Turn on `codebrain.atlassian.allowWrite` and the agent also gets `jira_add_comment`, `jira_get_transitions`, `jira_transition_issue`, `jira_assign_issue`, `confluence_create_page`, `confluence_update_page` and `confluence_add_comment` — enough to comment what it found, move a ticket to In Progress, take it, or write the finding up as a page. While the setting is off those tools are not offered to any agent at all, so the server can only read. Every write reports back exactly what changed (the new status, the new page version, a direct URL), and page updates default to appending rather than replacing, so an agent cannot quietly overwrite someone's document.

**Setup — once, for all agents:**

1. Run **CodeBrain: Configure Atlassian (Collab + Jira)** and enter the base URLs and your personal access tokens.
   - Server / Data Center: create a token under *Profile → Personal Access Tokens*.
   - Cloud: use an API token and enter your account email when prompted. Confluence Cloud URLs must include the `/wiki` context path.
   - You can configure only Jira, only Confluence, or both — tools for an unconfigured product are never shown to the agent.
2. GitHub Copilot picks the server up immediately, with no config file to edit.
3. For **Claude Code**, **Codex CLI**, **Gemini CLI**, or **Antigravity**, run **CodeBrain: Register Atlassian MCP with Agents**, choose global or workspace scope, pick the ones you use, then restart that agent.

**Where your credentials live:** tokens go into the OS keychain via VS Code SecretStorage, and are mirrored once to `~/.codebrain/atlassian.env` (owner-only, mode `0600`) — the only way agents outside VS Code can read them. Every agent config file CodeBrain writes contains just the command to run, so a committed `.mcp.json` never leaks a token. **CodeBrain: Clear Atlassian Credentials** removes both copies; **CodeBrain: Unregister Atlassian MCP from Agents** removes the config entries.

Use **CodeBrain: Test Atlassian Connection** to verify access; results also go to the **CodeBrain Atlassian** output channel.

---

## ⚙️ Configuration Settings
Customize CodeBrain by editing your `.vscode/settings.json`:

| Setting | Default | Description |
| :--- | :--- | :--- |
| `codebrain.autoRefresh.enabled` | `true` | Keep the index fresh with CodeBrain's native file watcher. |
| `codebrain.autoRefresh.debounceMs` | `1000` | Quiet period (ms) before sync triggering. |
| `codebrain.chat.maxContextFiles` | `12` | Max files returned by CodeBrain for a chat report. |
| `codebrain.chat.maxDiffCharacters`| `120000` | Max Git diff size supplied to code review commands. |
| `codebrain.chat.showTokenUsage` | `true` | Show estimated token counts/latency in chat responses. |
| `codebrain.ai.model` | `""` | Model id for CodeBrain-owned AI commands such as **CodeBrain: Review Changes**. Empty uses the first available model; it does not override ChatParticipant model selection. |
| `codebrain.impact.maxDepth` | `5` | Maximum dependency depth for affected-test detection. |
| `codebrain.impact.detectDepthTruncation` | `true` | Detect whether the traversal was cut short by `maxDepth` and report counts as a lower bound when it was. |
| `codebrain.codeLens.enabled` | `true` | Show each file's blast radius as a CodeLens above line 1. |
| `codebrain.tests.command` | `""` | Command for **Run Affected Tests**, using `${files}`. Empty detects the runner and confirms first. |
| `codebrain.metrics.enabled` | `true` | Record local token savings and analytics. |
| `codebrain.reports.openPreview` | `true` | Automatically open generated Markdown reports in preview mode. |
| `codebrain.releaseNotes.showOnUpdate` | `true` | Open a "What's new" page after an update, covering every release since the version you were on. Never on a fresh install, never twice for the same version. |
| `codebrain.atlassian.jiraUrl` | `""` | Jira base URL, e.g. `https://jira.example.com`. Tokens are stored in the OS keychain, never here. |
| `codebrain.atlassian.confluenceUrl` | `""` | Confluence (Collab) base URL **including its context path**, e.g. `https://site.atlassian.net/wiki`. |
| `codebrain.atlassian.username` | `""` | Atlassian account email. Cloud only — Server/Data Center tokens need no username. |
| `codebrain.atlassian.maxResults` | `10` | Default number of issues, pages, or comments per search (max 50). |
| `codebrain.atlassian.maxBodyCharacters` | `12000` | Max characters of a page body or issue description per tool call; longer content is truncated with a visible note. |
| `codebrain.atlassian.allowWrite` | `false` | Let agents change Jira and Confluence — comment, transition, assign, and create/update pages. While off, those tools are not offered to any agent. |
| `codebrain.atlassian.maxImageBytes` | `4194304` | Largest single attached image returned inline by the image tools. Bigger ones are named and skipped. |
| `codebrain.atlassian.sslVerify` | `true` | Verify the TLS certificate of the Jira/Confluence hosts. Disable only for a private certificate authority. |
| `codebrain.jira.defaultProject` | `""` | Jira project keys the board starts filtered to, e.g. `TPLD, WEB`. |
| `codebrain.jira.maxIssues` | `100` | How many issues one board load fetches (10–500). The board says so when Jira had more. |
| `codebrain.jira.autoRefreshMinutes` | `10` | Minutes between automatic board reloads, only while the window has focus. `0` disables it. |
| `codebrain.jira.dueSoonDays` | `3` | An open issue due within this many days is flagged as due soon. |
| `codebrain.jira.staleDays` | `5` | An in-progress issue with no update for this long is flagged as stale. |
| `codebrain.jira.branchTemplate` | `{prefix}/{key}-{summary}` | Suggested branch name. Placeholders: `{key}`, `{summary}`, `{prefix}`, `{type}`. |
| `codebrain.jira.baseBranch` | `""` | Branch a new issue branch is created from. Empty branches off whatever is checked out. |
| `codebrain.jira.jql` | `""` | Advanced: JQL replacing every generated condition. Ordering is appended unless yours has `ORDER BY`. |
| `codebrain.jira.statusBar` | `true` | Show the current branch's issue key and status in the status bar. |

---

## 📋 Extension Commands
- `CodeBrain: Initialize Workspace` — Index the workspace.
- `CodeBrain: Refresh Index` — Force index update.
- `CodeBrain: Rebuild Index` — Full rebuild, for a partial or outdated index.
- `CodeBrain: Show Index Status` — Open the index status and coverage panel.
- `CodeBrain: Choose Project` — Pin which indexed project to analyze (monorepos).
- `CodeBrain: Run Affected Tests` — Run the tests affected by your changes.
- `CodeBrain: Analyze Change Impact` — Check the change impact.
- `CodeBrain: Review Changes` — Run an independent AI review using Git diff and CodeGraph context, then publish inline diagnostics and a temporary Markdown report.
- `CodeBrain: Choose AI Model` — Select the model used by CodeBrain-owned AI commands.
- `CodeBrain: Open Workflow Graph` — Open the interactive visual graph.
- `CodeBrain: Token Savings Dashboard` — Open the savings metrics UI.
- `CodeBrain: Reset Token Savings` — Clear metrics history.
- `CodeBrain: Restore Dismissed Review Findings` — Bring back dismissed findings.
- `CodeBrain: Export Latest Report as Markdown` — Export findings.
- `CodeBrain: Configure Atlassian (Collab + Jira)` — Enter the base URLs and personal access tokens for Jira and Confluence.
- `CodeBrain: Generate Commit Message` — Write a commit message for the staged changes into the Source Control input box.
- `CodeBrain: Choose Commit Message Format` — Pick the commit message style, or switch to a custom template.
- `CodeBrain: Customize Commit Message Template` — Create and open the repository's commit message template.
- `CodeBrain: Install CodeBrain for Agents (Claude, Codex, Gemini…)` — Add the code graph MCP server and/or the CodeBrain skill to Claude Code, Codex CLI, Gemini CLI, Antigravity, and GitHub Copilot, globally or for this workspace.
- `CodeBrain: Uninstall CodeBrain from Agents` — Remove both again, at every scope.
- `CodeBrain: Register Atlassian MCP with Agents` — Add the Atlassian MCP server to the same agents.
- `CodeBrain: Unregister Atlassian MCP from Agents` — Remove those config entries.
- `CodeBrain: Test Atlassian Connection` — Make one authenticated call per configured product and report the result.
- `CodeBrain: Clear Atlassian Credentials` — Forget the tokens, URLs, and the shared credentials file.
- `CodeBrain: Open Jira Board` — Open the full board, with charts, in an editor tab.
- `CodeBrain: Refresh Jira Board` — Reload the board from Jira now.
- `CodeBrain: Check Out Branch for a Jira Issue` — Pick a ticket and switch to, track, or create its branch.
- `CodeBrain: Open the Jira Issue for This Branch` — Open the ticket the current branch name refers to.

---

## ⚠️ Requirements & Limitations
- **VS Code Version**: `^1.100.0` or newer.
- **Trusted Workspace**: CodeBrain runs a local runtime and reads local workspace files; it requires workspace trust to be enabled.
- **Filesystem Workspace**: Virtual workspaces are not supported.
- **Chat Models**: Chat commands (`/explain`, `/review`, `/impact`, `/fix`, `/guide` from chat) require an active model available through VS Code Chat. **CodeBrain: Review Changes** requires a model available through the VS Code Language Model API and uses `codebrain.ai.model` when configured. Deterministic local commands (e.g. Impact scoring, Workflow Graph, Index status, export) work offline without a chat model.

---

## 🛠️ Troubleshooting

- **Workspace Index Missing**: Make sure you have run **CodeBrain: Initialize Workspace** first.
- **Index Not Updating**: Check if `codebrain.autoRefresh.enabled` is `true`. You can also trigger a manual refresh using **CodeBrain: Refresh Index**. CodeBrain skips the refresh before an analysis when nothing in the workspace has changed since the last one.
- **Impact Results Look Too Small**: Open **CodeBrain: Show Index Status** and check the coverage gaps section — files in an unsupported language are absent from the graph. Also check whether the report says the traversal was truncated; if so, raise `codebrain.impact.maxDepth`.
- **A Finding Is Wrong**: Dismiss it from the lightbulb menu. It stays hidden in future reviews; **CodeBrain: Restore Dismissed Review Findings** undoes this.
- **No Affected Tests Detected**: Make sure tests follow standard patterns (e.g., in a `tests/` directory or ending in `.test.*` / `.spec.*`) and that CodeBrain can resolve dependencies between the test files and the target source code.
- **No Language Model Available**: Sign in to or enable a VS Code Language Model provider before running **CodeBrain: Review Changes**. Use **CodeBrain: Choose AI Model** to select an available model.
- **Configured Model Unavailable**: Clear `codebrain.ai.model` or replace it with the model id shown by **CodeBrain: Choose AI Model**.
- **No Inline Findings**: Inline diagnostics require the model to emit file/line finding markers; the full Markdown review is still available in the temporary preview report.
- **"Permission Denied" Running the Runtime (Linux/macOS)**: You should never have to `chmod` anything by hand — CodeBrain checks its bundled runtime at startup and restores the execute bit if the installer dropped it, noting the repair in the **CodeBrain** output channel. The automatic repair only fails when the extension directory is read-only or owned by another user, and the error message then names the exact `chmod +x` command to run.
- **WASM Fallback Warning**: If you see a warning that CodeBrain is using WASM fallback, your installed `.vsix` may not match your system architecture. The extension will still work but without the performance acceleration of the native Rust kernel.
- **Atlassian Tools Missing in Copilot**: The Atlassian server only appears once a product is fully configured — both a base URL and a token. Run **CodeBrain: Configure Atlassian (Collab + Jira)**, then **CodeBrain: Test Atlassian Connection**.
- **CodeBrain Tools Missing in Claude Code / Codex / Gemini / Antigravity**: Run **CodeBrain: Install CodeBrain for Agents** and restart the agent — MCP servers are only read at startup. A workspace-scoped registration only applies to that folder — register globally if you want it everywhere.
- **Atlassian Tools Missing in Claude Code / Codex / Gemini / Antigravity**: Run **CodeBrain: Register Atlassian MCP with Agents** and restart the agent. The same project-scope note applies to Claude Code.
- **Atlassian Token Rejected (401)**: Server/Data Center tokens authenticate as a bearer token with no username; Cloud API tokens need your account email in `codebrain.atlassian.username`. Re-run the configure command to replace a rotated token.
- **Confluence Returns 404 for Everything**: A Cloud Confluence URL must include the `/wiki` context path (`https://site.atlassian.net/wiki`).
- **Atlassian Host Behind a Private CA**: Set `codebrain.atlassian.sslVerify` to `false`, or export `CODEBRAIN_ATLASSIAN_SSL_VERIFY=false` for agents launched outside VS Code.
- **Logs**: Open VS Code Output view and select **CodeBrain** from the dropdown menu to inspect stdout, stderr, and execution logs. Atlassian setup and connection tests log to the **CodeBrain Atlassian** channel.
