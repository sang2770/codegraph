# CodeBrain for VS Code - Development Guide

This guide is for developers working on the CodeBrain VS Code extension.

## Development Setup

### Prerequisites

- **Node.js 24** or newer.
- **Rust stable** to compile the native kernel. Without Rust, local development builds fall back to WASM unless `CODEGRAPH_REQUIRE_NATIVE_KERNEL=1` is specified.
- **bash**, **curl**, and **tar** (available natively on Unix/macOS, or via Git Bash/WSL on Windows).
- **unzip** (specifically when building a Windows runtime on Unix platforms).

### Install Dependencies

Install dependencies for both the monorepo root and the VS Code extension:

```bash
cd ..
npm ci
cd vscode-extension
npm ci
```

---

## Build Commands

### Build Extension Code Only
This compiles the TypeScript files and bundles the extension using esbuild:
```bash
npm run build
```

This produces **two** bundles:

- `dist/extension.js` — the extension host entry point (`vscode` stays external).
- `dist/atlassian-server.js` — the standalone stdio MCP server for Jira and Confluence. It runs as its own process, spawned by VS Code for Copilot and directly from their config files by Claude Code, Codex, and Antigravity, so it must never import `vscode`. That import is *not* marked external for this bundle, which turns an accidental dependency on the extension host into a build failure rather than a runtime crash inside an agent the user cannot debug.

### Build and Stage Runtime
This builds and packages the platform-specific CodeBrain runtime for the current machine:
```bash
npm run build:runtime
```

### Build All
Builds both the runtime and the extension source code:
```bash
npm run build:all
```

The runtime builder invokes the repository's canonical `scripts/build-bundle.sh` script, then extracts the resulting self-contained bundle into:
```text
runtime/<target>/
  node | node.exe
  lib/dist/
  lib/kernel/codegraph-kernel.node
  lib/node_modules/
  bin/
```

---

## Testing

To run TypeScript compilation checks and the extension integration tests (tests language detection, impact reporting, token estimates, and runtime-target handling):
```bash
npm test
```

### Atlassian MCP Server, By Hand
The stdio server can be driven without VS Code or an agent. Point it at a
credentials file and speak JSON-RPC on stdin, one message per line:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"jira_search","arguments":{"query":"rollback","limit":3}}}' \
| CODEBRAIN_ATLASSIAN_ENV=/path/to/atlassian.env node dist/atlassian-server.js
```

Diagnostics go to stderr; stdout carries protocol traffic only. Useful
environment overrides: `CODEBRAIN_ATLASSIAN_ENV` (credentials file path),
`CODEBRAIN_ATLASSIAN_MAX_RESULTS`, `CODEBRAIN_ATLASSIAN_MAX_BODY_CHARS`,
`CODEBRAIN_ATLASSIAN_MAX_IMAGE_BYTES`, `CODEBRAIN_ATLASSIAN_TIMEOUT_MS`,
`CODEBRAIN_ATLASSIAN_SSL_VERIFY=false`. The four `JIRA_*` / `CONFLUENCE_*`
variables also work directly and take precedence over the file; so do the
`CODEBRAIN_ATLASSIAN_*` ones, which may also be set inside the file itself (that
is how an agent launched with no environment of its own picks them up).

The tools that modify Jira and Confluence are hidden unless
`CODEBRAIN_ATLASSIAN_ALLOW_WRITE` is `1`/`true`/`yes`/`on` — anything else,
including a half-set value, keeps the server read-only. The startup line on
stderr says which mode it came up in (`ready: Jira + Confluence (read-only)`).
The VS Code setting `codebrain.atlassian.allowWrite` drives the same flag and
writes it into the shared env file, so toggling it moves every agent at once.
To exercise a write by hand, add the variable to the command above:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"jira_add_comment","arguments":{"key":"ABC-1","body":"from the CLI"}}}' \
| CODEBRAIN_ATLASSIAN_ALLOW_WRITE=1 CODEBRAIN_ATLASSIAN_ENV=/path/to/atlassian.env node dist/atlassian-server.js
```

### Packaged-Runtime Smoke Test
You can manually run a smoke test against the packaged runtime:
```bash
runtime/<target>/node \
  --liftoff-only \
  --disable-warning=ExperimentalWarning \
  runtime/<target>/lib/dist/bin/codegraph.js \
  --version
```

---

## Packaging

Packaging produces platform-specific `.vsix` files. Each `.vsix` contains exactly one runtime target (e.g., node, native binary, libraries for a specific OS/Arch) so we avoid shipping all six runtimes to every user.

> **Package POSIX targets from macOS or Linux.** The staging step sets the
> execute bit on `runtime/<target>/node` and `runtime/<target>/bin/codegraph`,
> and `vsce` copies those modes into the `.vsix`. Windows has no unix execute
> bit to record, so a `linux-*` or `darwin-*` package built there ships without
> one — the build warns, and the extension repairs the bit on first run
> (`ensureRuntimeExecutable` in `src/runtime.ts`), but the clean fix is to build
> those targets on a POSIX host.

### Pack for Current Host
Builds a `.vsix` package matching your current platform:
```bash
npm run package
```

### Pack for a Specific Target
```bash
npm run package -- --target linux-x64
```

### Pack for All Supported Targets
Builds `.vsix` files for all supported platforms:
```bash
npm run package:all
```

Supported targets:
- `darwin-arm64` (macOS Apple Silicon)
- `darwin-x64` (macOS Intel)
- `linux-arm64`
- `linux-x64`
- `win32-arm64`
- `win32-x64`

---

## Publishing from CI (the normal path)

The **VS Code extension** GitHub workflow builds all six platform packages —
`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`,
`win32-x64` — each on its own runner, because a runtime can only be built on
the platform it targets. Every push that touches the extension runs the build
and the tests and leaves the six `.vsix` files as artifacts. **Publishing never
happens on a push.**

To release:

1. Write what changed under `## [Unreleased]` in `vscode-extension/CHANGELOG.md`.
2. Bump `version` in `vscode-extension/package.json` and land both on `main`.
   Republishing an existing version is rejected by the marketplace, so the bump
   is what makes the release possible at all.
3. **Actions → VS Code extension → Run workflow**, tick **publish**.

Inputs:

| Input | Effect |
| --- | --- |
| `publish` | Upload to the marketplace. Off by default — the run just builds. |
| `pre_release` | Package and publish as a pre-release. Must be set for the build, not only the upload: the flag is stamped into the archive at package time. |
| `skip_duplicate` | Succeed instead of failing when the version already exists. |
| `allow_empty_changelog` | Release even though `## [Unreleased]` holds nothing. |

The run does a **preflight** first, so anything that would reject the release
costs seconds instead of a full six-runner build:

- **`VSCE_PAT` must be set.** A marketplace personal access token for the
  `sang2nguyen-LGE` publisher, with the *Marketplace → Manage* scope. Azure
  DevOps PATs expire (a year at most), so a publish that suddenly fails
  authentication usually needs a new token rather than a code change.
- **The changelog is promoted** by `scripts/prepare-release.mjs`:
  `## [Unreleased]` becomes `## [<version>] - <YYYY-MM-DD>` with a fresh empty
  `[Unreleased]` opened above it, and the result is committed back to the
  branch with `[skip ci]`. The package jobs then build **that** commit, so the
  shipped archive carries a changelog naming its own version. This matters
  twice over: the marketplace renders the file on the extension's Changelog
  tab, and `src/releaseNotes.ts` reads it for the "What's new" page shown after
  an update. Re-running a failed release is safe — a second promotion is a
  no-op. With nothing under `[Unreleased]` the release **stops** rather than
  shipping a blank "What's new"; `allow_empty_changelog` overrides that.
  (This needs the workflow to be able to push to the branch. If it is
  protected against Actions, run `npm run prepare-release` locally, commit, and
  the preflight will find nothing left to do.)

The packages are then built per target and published all six in **one**
`vsce publish` call — uploading them one at a time would leave a half-published
version on the store if a later upload failed. Before uploading,
`scripts/publish-packaged.mjs` reads each archive back through
`scripts/verify-vsix.mjs` and fails if it holds another target's runtime or
records `node` as non-executable.

---

## Publishing by hand

Still supported, and the right tool when CI is unavailable or you want to ship
a subset of targets from a machine that already has their runtimes staged.

`scripts/publish-extension.mjs` packages the Linux and Windows targets and
pushes them with the locally installed, already logged-in `vsce`. Unlike
`npm run package`, it **never builds or deletes a runtime** — stage those by
hand first, in any order you like, and they all survive:

```bash
node ./scripts/build-runtime.mjs linux-x64
node ./scripts/build-runtime.mjs win32-x64
```

Then:

```bash
npm run package:store     # build + package linux-x64 and win32-x64, no upload
npm run publish:store     # the same, then publish after a confirmation prompt
```

Options (pass after `--` when going through npm):

| Flag | Effect |
| --- | --- |
| `--targets a,b` | Targets to ship. Default `linux-x64,win32-x64`. |
| `--publish` | Upload to the marketplace (what `publish:store` adds). |
| `--pre-release` | Mark the packages as pre-release. |
| `--skip-duplicate` | Do not fail when the version is already published. |
| `--skip-build` | Reuse the current `dist/` instead of rebuilding. |
| `--yes` | Skip the confirmation prompt (required for non-interactive runs). |

Before packaging anything it refuses targets whose runtime is missing or
incomplete, sets the execute bit on POSIX launchers, and warns when a runtime
carries no native kernel (that ships a working but WASM-only extension). After
packaging it reads each `.vsix` back and fails if the archive does not hold
exactly this target's runtime, or records `node` as non-executable — a store
package with either problem is broken for every user who installs it.

Every target is published in a single `vsce publish` call, so the marketplace
sees one version with all its platform packages rather than a half-published
version if one upload fails. Version bumps stay manual: edit `version` in
`package.json` first, since republishing an existing version is rejected.

`npm run package -- --target <target> --pre-release` marks a single package as
a pre-release, which is what the CI workflow's `pre_release` input drives.
