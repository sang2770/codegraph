# CodeBrain VS Code Extension Guide

CodeBrain builds a local semantic code graph of your repository so AI tools answer questions about your code from structure instead of from repeated file reads. It ships a native-accelerated runtime, an MCP server, an Agent Skill, a chat participant, independent AI code review, change-impact analysis, affected-test detection, commit message generation, and a workflow visualization — all inside VS Code.

Everything runs locally. No source code leaves your machine; only the prompts you send to your configured AI model do.

## Getting started

### 1. Install

CodeBrain ships as a platform-specific `.vsix` containing a bundled Node.js runtime and a native Rust kernel. **You do not need Node.js or any CLI installed.**

1. Command Palette (`Ctrl+Shift+P`) → **Extensions: Install from VSIX...**
2. Pick the file matching your OS and architecture: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`
3. Reload VS Code when prompted

### 2. Index your repository

1. Open your project folder
2. Command Palette → **CodeBrain: Initialize Workspace**
3. A local `.codegraph/` directory is created at the workspace root
4. The status bar shows `CodeBrain: Ready` when indexing finishes

The first index takes a while on a large codebase. After that, updates are incremental and the index refreshes itself as you edit.

## Features

### Chat participant — `@codebrain`

Ask about your codebase directly in VS Code Chat. CodeBrain detects the language of your question (English, Vietnamese, and others) and answers in it.

| Command | What it does |
|---|---|
| `/explain` | Explains the business workflow and maps each step to concrete functions, files and line numbers, with Mermaid diagrams |
| `/review` | Reviews your changes against the codebase's conventions, contracts and call paths |
| `/impact` | Analyzes the blast radius of a change |
| `/fix` | Traces a reported bug to its root cause and proposes a solution plus a validation plan (analysis only — it does not edit files) |
| `/guide` | Generates a user-facing Markdown guide for a feature: prerequisites, steps, examples, troubleshooting |

Examples:

```
@codebrain /explain How does the authentication middleware work?
@codebrain /impact What is the impact of modifying refreshSession?
@codebrain /fix Login returns 401 after the token refresh succeeds
```

### Generate a commit message

Click the **sparkle icon** in the Source Control title bar. CodeBrain writes the commit message straight into the message box.

It describes your **staged** changes — exactly what the next commit will contain — and falls back to the whole working tree when nothing is staged. If the box already had text, the notification offers **Undo**.

**Choose your format** with **CodeBrain: Choose Commit Message Format**. The picker shows a real example of each rather than a name to guess at:

| Format | Looks like |
|---|---|
| Conventional Commits | `feat(auth): add refresh tokens` |
| Issue key + summary | `TPLD-958: Fix Chart lag issue`, a blank line, then a nested `-` / `+` / `*` detail list |
| Plain summary | `Fix chart lag when the window is resized` |

The prompt carries the **current branch name** and the last few commit subjects, so a format can take the issue key straight from `feature/TPLD-958-chart-lag` and match the style already in your history. A branch with no issue key gets no prefix rather than an invented one.

Set `codebrain.commit.language` to write in another language, for example `Vietnamese`. Identifiers, paths and issue keys are left as they are.

**Need something else?** Pick **Custom template…** in the same list to create `.codebrain/commit-template.md`, pre-filled with whichever format is active. That file *replaces* the built-in format — a rule you delete stops being applied — and it is read from the repository root, so committing it gives your whole team one convention. Delete it to go back to the picker.

### Blast radius CodeLens

Every file shows its blast radius above line 1, with no command to run:

```
⚡ CodeBrain: 23 dependents · 2 affected tests
🧪 Run 2 affected tests
```

Click the first lens for a full impact analysis, the second to run just those tests. Turn it off with `codebrain.codeLens.enabled`.

### Change impact and affected tests

**CodeBrain: Analyze Change Impact** (or `@codebrain /impact`) works from your tracked, staged or untracked Git changes, falling back to the active file when the tree is clean. It:

1. Traverses call graphs to find affected dependencies up to a configurable depth
2. Locates affected test files
3. Classifies risk from fan-out, public contracts and test coverage gaps
4. **Says when the traversal hit its depth limit** and reports dependent counts as a lower bound (`≥ N`) instead of presenting a partial result as the full blast radius

### Run affected tests

**CodeBrain: Run Affected Tests** — from the CodeLens, the Source Control title bar, the impact panel, or the Command Palette.

It detects your runner (Vitest, Jest, Playwright, Mocha, pytest, `go test`, RSpec, PHPUnit, Cargo, Maven, Gradle, `dotnet test`) and **always shows the command for confirmation** before running it, because detection can be wrong. Set `codebrain.tests.command` (with `${files}`) to skip detection.

### Independent AI code review

**CodeBrain: Review Changes** from the Source Control title menu combines your Git diff with graph evidence and calls a model through the VS Code Language Model API. It produces:

- A verdict and merge recommendation
- Critical / high / medium / low findings with file and line references
- Affected workflows, graph evidence, affected tests and missing coverage
- Inline diagnostics in the reviewed files and in the Problems panel

Findings survive a window reload and re-anchor to the reviewed line's content after you edit a file — telling you when a finding moved, and admitting when the reviewed line no longer exists rather than pointing at the wrong code.

**Disagree with a finding?** Use the lightbulb to *dismiss* a false positive (it stays hidden in later reviews) or to *explain* it in chat. You can reply in the finding's comment thread to ask about it. **CodeBrain: Restore Dismissed Review Findings** brings them back.

Customize with **CodeBrain: Customize Review Instructions** and **CodeBrain: Choose Review Profile**.

### Interactive workflow graph

**CodeBrain: Open Workflow Graph** visualizes the impact path:

```
Changed Files ──> Dependents / Workflows ──> Affected Tests
```

Click any node to open the source file and line. The panel shows the active engine (`Rust native` or `WASM fallback`).

### Index status and coverage

**CodeBrain: Show Index Status** opens a panel showing:

- Files, symbols and relationships indexed, per language
- **Tracked only** files — indexed for change detection but with no symbols extracted, so they cannot appear in a call path
- **Coverage gaps** — workspace files missing from the index. This matters: an unsupported language is simply absent from the graph, so an impact analysis that should have crossed it is incomplete with no error to tell you
- Warnings when the last index run dropped files, left references unresolved, or was built by an older engine

### Context cost dashboard

**CodeBrain: Token Savings Dashboard** compares what the graph context cost against reading the same files in full.

The comparison is measured, not estimated from a constant: CodeBrain takes the files it actually drew evidence from, reads their real sizes on disk, and converts both sides at the same ratio. When no candidate file can be measured it reports the saving as **unknown** rather than showing a number. All metrics stay in VS Code's local workspace state — nothing is uploaded.

### Monorepo support

When a workspace holds several indexed projects, **CodeBrain: Choose Project** pins which one CodeBrain answers for. By default it follows the nearest indexed project above whichever file is open.

### Read-only reviewer agent

The **CodeBrain Reviewer** custom agent in VS Code Chat has CodeBrain's graph tools but no write or terminal permissions — for evidence-based reviews and release assessments where the agent must not change anything.

### Exportable Markdown reports

**CodeBrain: Export Latest Report as Markdown** saves the latest review or explanation, keeping headings, tables, code blocks and Mermaid diagrams intact.

## CodeBrain for every agent — MCP server + skill

Two things make CodeBrain useful to an AI agent: the **MCP server**, which gives it the graph tools, and the **skill**, which tells it when and how to use them.

Inside VS Code, GitHub Copilot gets both from the extension automatically. Every other agent reads its own configuration files, so run **CodeBrain: Install CodeBrain for Agents (Claude, Codex, Gemini…)**, choose a scope, choose what to install, tick the agents you use, and restart them.

**MCP server**

| Agent | Global — every project | This workspace only |
|---|---|---|
| Claude Code | `~/.claude.json` | `<workspace>/.mcp.json` |
| Codex CLI | `~/.codex/config.toml` | — |
| Gemini CLI | `~/.gemini/settings.json` | `<workspace>/.gemini/settings.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` | — |

**Skill** — installed through each agent's own mechanism wherever it has one, because a skill or slash command is loaded only when it is relevant, while an instructions file is loaded into every request:

| Agent | Mechanism | Global | This workspace only |
|---|---|---|---|
| Claude Code | skill | `~/.claude/skills/codebrain/SKILL.md` | `<workspace>/.claude/skills/codebrain/SKILL.md` |
| Codex CLI | prompt — run `/codebrain` | `~/.codex/prompts/codebrain.md` | — |
| Gemini CLI | command — run `/codebrain` | `~/.gemini/commands/codebrain.toml` | `<workspace>/.gemini/commands/codebrain.toml` |
| Antigravity | instructions section | `~/.gemini/GEMINI.md` | — |
| GitHub Copilot | instructions section | — | `<workspace>/.github/copilot-instructions.md` |

Every agent is given the same text, so there is no second copy to drift. The instructions-file sections are wrapped in `<!-- CODEBRAIN_SKILL_START -->` / `<!-- CODEBRAIN_SKILL_END -->` markers: anything you wrote around them is preserved, and uninstalling removes only the marked section.

**Which scope?** Global is usually what you want: the MCP entry carries no workspace path, so each agent starts the server in whatever folder you are working in and CodeBrain answers from the nearest indexed project — one installation covers every repository you open. Pick the workspace scope when it should travel with the repository (`.mcp.json` and the skill files hold no tokens, so they are safe to commit). Codex CLI and Antigravity have no project-scoped configuration and are only offered globally; Copilot's instructions file belongs to a repository and is only offered for the workspace.

Every MCP entry points at the extension's own bundled runtime — no Node.js install, no `npm i -g`, and no PATH surprises when an agent is launched from a GUI. A repository with no `.codegraph/` simply reports that it is not indexed; run **CodeBrain: Initialize Workspace** there.

Extension updates move the bundled runtime's path and can change the skill text. CodeBrain rewrites what it already owns on the next activation, at whichever scope you installed it, so a registered agent keeps working across upgrades. **CodeBrain: Uninstall CodeBrain from Agents** sweeps both scopes and both halves.

**Restart the agent after installing** — MCP servers are only read at startup.

## Jira and Confluence (Collab) search for every agent

CodeBrain ships a second MCP server that lets an agent search Confluence (Collab) and Jira from inside the task it is already working on — the ticket behind a branch name, the spec behind a design decision, the discussion explaining why the code looks the way it does.

Seven read tools: `confluence_search`, `confluence_get_page`, `confluence_get_page_images`, `jira_search`, `jira_get_issue`, `jira_get_comments`, `jira_get_issue_images`. Page bodies and issue descriptions come back in full, so the agent does not have to ask you to paste anything, and the image tools return attached screenshots and diagrams as real images the agent can look at.

**Writing back is opt-in and off by default.** Turn on `codebrain.atlassian.allowWrite` to add `jira_add_comment`, `jira_get_transitions`, `jira_transition_issue`, `jira_assign_issue`, `confluence_create_page`, `confluence_update_page` and `confluence_add_comment`. While it is off, **those tools are not offered to any agent at all** — the server can only read. When it is on, every write reports back what it changed, and page updates append by default rather than replacing.

**Setup — once, for every agent:**

1. **CodeBrain: Configure Atlassian (Collab + Jira)** — enter the base URLs and your personal access tokens
   - Server / Data Center: create a token under *Profile → Personal Access Tokens*
   - Cloud: use an API token and enter your account email when prompted; Confluence Cloud URLs must include the `/wiki` context path
   - Configure only Jira, only Confluence, or both — tools for an unconfigured product are never shown to the agent
2. GitHub Copilot picks the server up immediately, with no config file to edit
3. For Claude Code, Codex CLI, Gemini CLI or Antigravity, run **CodeBrain: Register Atlassian MCP with Agents**, choose the scope, pick your agents, then restart them

**Where credentials live:** tokens go into the OS keychain through VS Code SecretStorage and are mirrored once to `~/.codebrain/atlassian.env` (owner-only, mode `0600`) — the only way agents outside VS Code can read them. Every agent config file CodeBrain writes contains just the command to run, so a committed `.mcp.json` never leaks a token.

**CodeBrain: Test Atlassian Connection** makes one authenticated call per configured product and reports exactly what failed. **CodeBrain: Clear Atlassian Credentials** removes both copies of the credentials; **CodeBrain: Unregister Atlassian MCP from Agents** removes the config entries.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `codebrain.autoRefresh.enabled` | `true` | Keep the index fresh with the native watcher |
| `codebrain.autoRefresh.debounceMs` | `1000` | Quiet period before a re-index |
| `codebrain.ai.model` | *(empty)* | Model for extension-owned AI commands; empty uses the first available |
| `codebrain.codeLens.enabled` | `true` | Blast radius CodeLens |
| `codebrain.chat.maxContextFiles` | `12` | Files pulled into chat context |
| `codebrain.chat.maxDiffCharacters` | `120000` | Diff budget for chat |
| `codebrain.chat.showTokenUsage` | `true` | Token footer in chat replies |
| `codebrain.impact.maxDepth` | `5` | Dependency traversal depth |
| `codebrain.impact.detectDepthTruncation` | `true` | Report counts as a lower bound when the traversal was cut short |
| `codebrain.commit.format` | `conventional` | Commit message format: `conventional`, `issue-summary`, `plain` |
| `codebrain.commit.language` | *(empty)* | Language for generated commit messages, e.g. `Vietnamese` |
| `codebrain.commit.templateFile` | `.codebrain/commit-template.md` | Custom commit template; overrides the format |
| `codebrain.commit.maxDiffCharacters` | `60000` | Diff budget for commit messages |
| `codebrain.review.profile` | `general` | Review lens |
| `codebrain.review.instructionFile` | `.codebrain/review-instructions.md` | Extra review priorities |
| `codebrain.review.refreshIndexBeforeRun` | `true` | Refresh the index before a review |
| `codebrain.tests.command` | *(empty)* | Test command with `${files}`; skips runner detection |
| `codebrain.reports.openPreview` | `true` | Open reports in preview |
| `codebrain.releaseNotes.showOnUpdate` | `true` | Open "What's new" after an update, covering every release since your previous version |
| `codebrain.metrics.enabled` | `true` | Local token-saving metrics |
| `codebrain.atlassian.*` | — | Jira / Confluence URLs, account email, result limits, image size limit, TLS verification |
| `codebrain.atlassian.allowWrite` | `false` | Let agents comment on, transition and assign Jira issues, and create/update Confluence pages. Off = read-only |

## Commands

| Command | Purpose |
|---|---|
| CodeBrain: Initialize Workspace | Create the local index |
| CodeBrain: Refresh Index / Rebuild Index | Update or rebuild it |
| CodeBrain: Show Index Status | Coverage, gaps and warnings |
| CodeBrain: Choose Project | Pin a project in a monorepo |
| CodeBrain: Analyze Change Impact | Blast radius for current changes |
| CodeBrain: Run Affected Tests | Run only the tests that matter |
| CodeBrain: Review Changes | Independent AI review |
| CodeBrain: Customize Review Instructions | Edit review priorities |
| CodeBrain: Choose Review Profile | Pick the review lens |
| CodeBrain: Generate Commit Message | Write the commit message |
| CodeBrain: Choose Commit Message Format | Pick the commit style |
| CodeBrain: Customize Commit Message Template | Edit the repository's template |
| CodeBrain: Install / Uninstall CodeBrain for Agents | MCP server + skill for other agents |
| CodeBrain: Configure Atlassian (Collab + Jira) | Connection settings |
| CodeBrain: Test Atlassian Connection | Verify access |
| CodeBrain: Register / Unregister Atlassian MCP with Agents | Atlassian server for other agents |
| CodeBrain: Clear Atlassian Credentials | Forget tokens and URLs |
| CodeBrain: Open Workflow Graph | Visualize the impact path |
| CodeBrain: Token Savings Dashboard | Measured context cost |
| CodeBrain: Export Latest Report as Markdown | Save the last report |
| CodeBrain: Choose AI Model | Model for extension-owned commands |
| CodeBrain: Next / Previous Review Finding | Navigate findings |
| CodeBrain: Restore Dismissed Review Findings | Unhide dismissed findings |
| CodeBrain: What's New | Release notes for the installed version |

## Requirements and limitations

- **VS Code 1.100 or newer.** No Node.js or external CLI needed — the runtime is bundled
- **A filesystem-backed workspace.** Virtual and untrusted workspaces are not supported: CodeBrain runs a local binary and reads workspace files
- **Chat, review, commit messages and other AI commands need a language model** available through the VS Code Language Model API. Indexing, the workflow graph, affected-test detection, the dashboard and export do not
- **A language the parsers do not support is absent from the graph**, so any analysis that should have crossed it is incomplete. Check **Show Index Status** for coverage gaps

## Troubleshooting

| Symptom | What to do |
|---|---|
| Status bar never reaches `Ready` | Check the CodeBrain output channel. A very large repository takes a while on the first index |
| Impact analysis looks incomplete | Open **Show Index Status** and look for coverage gaps and tracked-only files. Raise `codebrain.impact.maxDepth` if counts are reported as `≥ N` |
| No AI model available | Sign in to a model provider, or run **CodeBrain: Choose AI Model** |
| Commit message is not in the format you expect | Check **Choose Commit Message Format**, and whether a `.codebrain/commit-template.md` in the repository is overriding it |
| CodeBrain tools missing in Claude Code / Codex / Gemini / Antigravity | Run **Install CodeBrain for Agents** and restart the agent — MCP servers are only read at startup. A workspace-scoped install applies only to that folder |
| Atlassian tools missing in Copilot | The server only appears once a product is fully configured — both a base URL and a token. Run **Configure Atlassian**, then **Test Atlassian Connection** |
| Token rejected (401) | Server/DC tokens authenticate as bearer and need no username. Cloud API tokens need the account email in `codebrain.atlassian.username` |
| Confluence returns 404 for everything | A Confluence Cloud URL must include the `/wiki` context path |
| Atlassian host behind a private CA | Set `codebrain.atlassian.sslVerify` to `false`, or export `CODEBRAIN_ATLASSIAN_SSL_VERIFY=false` for agents launched outside VS Code |
| `permission denied` running the runtime (Linux/macOS) | CodeBrain repairs the execute bit itself at startup. If the extension folder is read-only, the error message names the exact `chmod` command to run |
