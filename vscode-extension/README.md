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

- **`/explain`**: Explains functions, files, or end-to-end workflows.
  - *Example*: `@codebrain /explain How does the authentication middleware work?`
  - It generates a structured Markdown report featuring a Mermaid flowchart of the code execution path.
- **`/review`**: Reviews active changes or selection against codebase conventions and architecture.
  - *Example*: `@codebrain /review Review my current changes`
  - It analyzes Git diffs and call paths to return risk levels (Critical/High/Medium/Low), structural bugs, boundary cases, and release recommendations.
- **`/impact`**: Analyzes the blast radius of changes.
  - *Example*: `@codebrain /impact What is the impact of modifying refreshSession?`
  - Automatically identifies affected workflows and dependent code paths.

### 🔍 Change Impact & Affected Tests
Analyze changes from tracked, staged, or untracked Git files (falling back to the active file if the repository is clean) using:
- Command: **CodeBrain: Analyze Change Impact**
- Chat: `@codebrain /impact`

The engine will:
1. Traverse call graphs to find affected dependencies up to a configurable depth.
2. Locate affected test files (e.g., `.test.*`, `.spec.*`, `tests/`).
3. Classify risk levels based on fan-out, public contracts, and test coverage gaps.

### 🧠 Independent AI Code Review
Run **CodeBrain: Review Changes** from the Source Control title menu or Command Palette for a review that is independent of Copilot Review.

The command combines the current Git diff with CodeGraph evidence and calls a model directly through the VS Code Language Model API. It produces a temporary Markdown report containing:

- Verdict and merge recommendation.
- Critical, high, medium, and low findings.
- File and line references when available.
- Affected workflows and graph evidence.
- Affected tests and missing test coverage.
- Inline diagnostics in the reviewed files and the Problems panel.

The report is also stored as the latest CodeBrain report and can be exported with **CodeBrain: Export Latest Report as Markdown**. This workflow does not read or depend on Copilot Review comments. The configured CodeBrain model is used by extension-owned AI commands; ChatParticipant requests continue using the model selected in VS Code Chat.

Use **CodeBrain: Choose AI Model** to select the model used by **CodeBrain: Review Changes** and future extension-owned AI commands. Leave the setting empty to use the first available provider model.

### 📊 Interactive Workflow Graph
Run **CodeBrain: Open Workflow Graph** to visualize the impact path:
```text
Changed Files ──> Dependents / Workflows ──> Affected Tests
```
- Click any node to open the corresponding source file and line.
- The interface displays the active engine (`Rust native` or `WASM fallback`).

### 📈 Token Savings Dashboard
Keep track of how much context (and API cost) CodeBrain is saving you by avoiding reading entire files.
- Command: **CodeBrain: Token Savings Dashboard**
- View metrics on avoided file reads, graph context tokens, baseline comparisons, and query latency.

> [!TIP]
> All metrics are stored locally inside VS Code's workspace state. No telemetry or billing data is uploaded.

### 🤖 Read-only CodeBrain Reviewer Agent
Use the custom agent **CodeBrain Reviewer** in VS Code Chat. It is granted CodeBrain-specific graph query tools without write or terminal permissions—ideal for secure, evidence-based code reviews and release assessments.

### 📄 Exportable Markdown Reports
Save generated reviews or explanations using the command **CodeBrain: Export Latest Report as Markdown**. Keep a lightweight record of complex analysis to review, share, or feed back to other AI models.

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
| `codebrain.metrics.enabled` | `true` | Record local token savings and analytics. |
| `codebrain.reports.openPreview` | `true` | Automatically open generated Markdown reports in preview mode. |

---

## 📋 Extension Commands
- `CodeBrain: Initialize Workspace` — Index the workspace.
- `CodeBrain: Refresh Index` — Force index update.
- `CodeBrain: Show Index Status` — Inspect the index state.
- `CodeBrain: Analyze Change Impact` — Check the change impact.
- `CodeBrain: Review Changes` — Run an independent AI review using Git diff and CodeGraph context, then publish inline diagnostics and a temporary Markdown report.
- `CodeBrain: Choose AI Model` — Select the model used by CodeBrain-owned AI commands.
- `CodeBrain: Open Workflow Graph` — Open the interactive visual graph.
- `CodeBrain: Token Savings Dashboard` — Open the savings metrics UI.
- `CodeBrain: Reset Token Savings` — Clear metrics history.
- `CodeBrain: Export Latest Report as Markdown` — Export findings.

---

## ⚠️ Requirements & Limitations
- **VS Code Version**: `^1.100.0` or newer.
- **Trusted Workspace**: CodeBrain runs a local runtime and reads local workspace files; it requires workspace trust to be enabled.
- **Filesystem Workspace**: Virtual workspaces are not supported.
- **Chat Models**: Chat commands (`/explain`, `/review`, `/impact` from chat) require an active model available through VS Code Chat. **CodeBrain: Review Changes** requires a model available through the VS Code Language Model API and uses `codebrain.ai.model` when configured. Deterministic local commands (e.g. Impact scoring, Workflow Graph, Index status, export) work offline without a chat model.

---

## 🛠️ Troubleshooting

- **Workspace Index Missing**: Make sure you have run **CodeBrain: Initialize Workspace** first.
- **Index Not Updating**: Check if `codebrain.autoRefresh.enabled` is `true`. You can also trigger a manual refresh using **CodeBrain: Refresh Index**.
- **No Affected Tests Detected**: Make sure tests follow standard patterns (e.g., in a `tests/` directory or ending in `.test.*` / `.spec.*`) and that CodeBrain can resolve dependencies between the test files and the target source code.
- **No Language Model Available**: Sign in to or enable a VS Code Language Model provider before running **CodeBrain: Review Changes**. Use **CodeBrain: Choose AI Model** to select an available model.
- **Configured Model Unavailable**: Clear `codebrain.ai.model` or replace it with the model id shown by **CodeBrain: Choose AI Model**.
- **No Inline Findings**: Inline diagnostics require the model to emit file/line finding markers; the full Markdown review is still available in the temporary preview report.
- **WASM Fallback Warning**: If you see a warning that CodeBrain is using WASM fallback, your installed `.vsix` may not match your system architecture. The extension will still work but without the performance acceleration of the native Rust kernel.
- **Logs**: Open VS Code Output view and select **CodeBrain** from the dropdown menu to inspect stdout, stderr, and execution logs.