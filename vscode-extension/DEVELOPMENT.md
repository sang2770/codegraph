# CodeBrain for VS Code - Development Guide

This guide is for developers working on the CodeBrain VS Code extension.

## Development Setup

### Prerequisites

- **Node.js 24** or newer.
- **Rust stable** — only for `npm run build:runtime` (a local development runtime). Normal development uses the npm-published runtime and needs no Rust.
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

### Runtime

The extension does **not** ship a runtime. At activation `src/runtimeManager.ts`
picks one, first match wins:

1. `codebrain.runtime.path` — a runtime directory you point at.
2. `runtime/<target>/` inside the extension folder — a development runtime.
3. The npm-managed install in global storage (`src/runtimeInstaller.ts`):
   `@xuansang2770/codegraph@<version>` installed with npm into
   `<globalStorage>/runtime/<version>/`, or — without npm — the
   `@xuansang2770/codegraph-<target>` tarball fetched from the registry,
   integrity-checked and unpacked with `tar`. `current.json` names the active
   version; updates land in a new version directory and only the pointer moves.

To develop against a local build of CodeGraph instead of the published one,
stage a development runtime (needs Rust for the native kernel, otherwise it
falls back to WASM unless `CODEGRAPH_REQUIRE_NATIVE_KERNEL=1`):

```bash
npm run build:runtime
```

That runs the repository's `scripts/build-bundle.sh` and extracts the bundle into
`runtime/<target>/` (`node`, `lib/dist/`, `lib/kernel/`, `lib/node_modules/`,
`bin/`). It is picked up on the next activation and never auto-updated; delete
the folder to go back to the npm-managed runtime. `.vscodeignore` keeps it out
of packages.

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

### Installed-Runtime Smoke Test
Run the runtime the extension installed (the path is logged in the **CodeBrain**
output channel):
```bash
<globalStorage>/runtime/<version>/node_modules/@xuansang2770/codegraph-<target>/node \
  --liftoff-only \
  --disable-warning=ExperimentalWarning \
  <same dir>/lib/dist/bin/codegraph.js \
  --version
```

---

## Packaging

Packaging produces **one universal `.vsix`** — no runtime inside, so it is a few
hundred KB and works on every OS and architecture:

```bash
npm run package                    # codebrain-<version>.vsix
npm run package -- --pre-release
```

`scripts/verify-vsix.mjs` reads the archive back and fails if anything under
`runtime/` slipped in or an entry point is missing.

To publish from a maintainer machine with a logged-in `vsce`:

```bash
node scripts/publish-extension.mjs --publish
```


## Publishing from CI (the normal path)

The **VS Code extension** GitHub workflow builds the universal package on one
runner. Every push that touches `vscode-extension/` runs the build and the
tests and leaves `codebrain.vsix` as an artifact. **Publishing never happens on
a push.** Runtime releases are separate: they go out through the root
repository's npm release, and installed extensions pick them up on their own.

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
costs seconds instead of a full build:

- **`VSCE_PAT` must be set.** A marketplace personal access token for the
  `sang2nguyen-LGE` publisher, with the *Marketplace → Manage* scope. Azure
  DevOps PATs expire (a year at most), so a publish that suddenly fails
  authentication usually needs a new token rather than a code change.
- **The changelog is promoted** by `scripts/prepare-release.mjs`:
  `## [Unreleased]` becomes `## [<version>] - <YYYY-MM-DD>` with a fresh empty
  `[Unreleased]` opened above it, and the result is committed back to the
  branch with `[skip ci]`. The package job then builds **that** commit, so the
  shipped archive carries a changelog naming its own version. This matters
  twice over: the marketplace renders the file on the extension's Changelog
  tab, and `src/releaseNotes.ts` reads it for the "What's new" page shown after
  an update. Re-running a failed release is safe — a second promotion is a
  no-op. With nothing under `[Unreleased]` the release **stops** rather than
  shipping a blank "What's new"; `allow_empty_changelog` overrides that.
  (This needs the workflow to be able to push to the branch. If it is
  protected against Actions, run `npm run prepare-release` locally, commit, and
  the preflight will find nothing left to do.)

Before uploading, `scripts/publish-packaged.mjs` reads the archive back through
`scripts/verify-vsix.mjs` and fails if it carries a runtime or misses an entry
point.

---

## Publishing by hand

Still supported, and the right tool when CI is unavailable.
`scripts/publish-extension.mjs` builds, packages and verifies the universal
`.vsix`, then pushes it with the locally installed, already logged-in `vsce`:

```bash
npm run package:store     # build + package, no upload
npm run publish:store     # the same, then publish after a confirmation prompt
```

Options (pass after `--` when going through npm):

| Flag | Effect |
| --- | --- |
| `--publish` | Upload to the marketplace (what `publish:store` adds). |
| `--pre-release` | Mark the package as pre-release. |
| `--skip-duplicate` | Do not fail when the version is already published. |
| `--skip-build` | Reuse the current `dist/` instead of rebuilding. |
| `--yes` | Skip the confirmation prompt (required for non-interactive runs). |

Version bumps stay manual: edit `version` in `package.json` first, since
republishing an existing version is rejected.
