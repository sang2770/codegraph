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

### 🔗 Jira & Confluence (Collab) Search for Every Agent
CodeBrain ships a second, read-only MCP server that lets an agent search your team's Confluence (Collab) and Jira from inside the task it is already working on — the ticket behind a branch name, the spec behind a design decision, the discussion that explains why the code looks the way it does.

Five tools, all read-only: `confluence_search`, `confluence_get_page`, `jira_search`, `jira_get_issue`, `jira_get_comments`. Page bodies and issue descriptions come back in full, so the agent does not have to ask you to paste anything. Nothing in the server can create, edit, or transition an issue.

**Setup — once, for all agents:**

1. Run **CodeBrain: Configure Atlassian (Collab + Jira)** and enter the base URLs and your personal access tokens.
   - Server / Data Center: create a token under *Profile → Personal Access Tokens*.
   - Cloud: use an API token and enter your account email when prompted. Confluence Cloud URLs must include the `/wiki` context path.
   - You can configure only Jira, only Confluence, or both — tools for an unconfigured product are never shown to the agent.
2. GitHub Copilot picks the server up immediately, with no config file to edit.
3. For **Claude Code**, **Codex CLI**, or **Antigravity**, run **CodeBrain: Register Atlassian MCP with Agents** and pick the ones you use, then restart that agent.

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
| `codebrain.atlassian.jiraUrl` | `""` | Jira base URL, e.g. `https://jira.example.com`. Tokens are stored in the OS keychain, never here. |
| `codebrain.atlassian.confluenceUrl` | `""` | Confluence (Collab) base URL **including its context path**, e.g. `https://site.atlassian.net/wiki`. |
| `codebrain.atlassian.username` | `""` | Atlassian account email. Cloud only — Server/Data Center tokens need no username. |
| `codebrain.atlassian.maxResults` | `10` | Default number of issues, pages, or comments per search (max 50). |
| `codebrain.atlassian.maxBodyCharacters` | `12000` | Max characters of a page body or issue description per tool call; longer content is truncated with a visible note. |
| `codebrain.atlassian.sslVerify` | `true` | Verify the TLS certificate of the Jira/Confluence hosts. Disable only for a private certificate authority. |

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
- `CodeBrain: Register Atlassian MCP with Agents` — Add the Atlassian MCP server to Claude Code, Codex CLI, and/or Antigravity.
- `CodeBrain: Unregister Atlassian MCP from Agents` — Remove those config entries.
- `CodeBrain: Test Atlassian Connection` — Make one authenticated call per configured product and report the result.
- `CodeBrain: Clear Atlassian Credentials` — Forget the tokens, URLs, and the shared credentials file.

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
- **Atlassian Tools Missing in Claude Code / Codex / Antigravity**: Run **CodeBrain: Register Atlassian MCP with Agents** and restart the agent. Claude Code entries are project-scoped (`<workspace>/.mcp.json`), so a different folder needs its own registration.
- **Atlassian Token Rejected (401)**: Server/Data Center tokens authenticate as a bearer token with no username; Cloud API tokens need your account email in `codebrain.atlassian.username`. Re-run the configure command to replace a rotated token.
- **Confluence Returns 404 for Everything**: A Cloud Confluence URL must include the `/wiki` context path (`https://site.atlassian.net/wiki`).
- **Atlassian Host Behind a Private CA**: Set `codebrain.atlassian.sslVerify` to `false`, or export `CODEBRAIN_ATLASSIAN_SSL_VERIFY=false` for agents launched outside VS Code.
- **Logs**: Open VS Code Output view and select **CodeBrain** from the dropdown menu to inspect stdout, stderr, and execution logs. Atlassian setup and connection tests log to the **CodeBrain Atlassian** channel.
