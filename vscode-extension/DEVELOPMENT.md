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
