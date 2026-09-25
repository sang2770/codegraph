import { build } from 'esbuild';

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  // Prefer a package's ESM build. jsonc-parser's `main` is a UMD wrapper whose
  // `require('./impl/format')` esbuild cannot follow, so it would be left as a
  // runtime require of a file that is not in dist/ and activation would fail.
  mainFields: ['module', 'main'],
};

await build({
  ...shared,
  entryPoints: ['src/extension.ts'],
  external: ['vscode'],
  outfile: 'dist/extension.js',
});

// Standalone stdio MCP server for Jira + Confluence. Bundled separately
// because it runs as its own process — spawned by VS Code for Copilot, and by
// Claude Code / Codex / Antigravity straight from their config files — so it
// must not pull in the extension host. `vscode` is deliberately NOT listed as
// external: an accidental import has to fail the build here rather than at
// runtime inside an agent the user cannot debug.
await build({
  ...shared,
  entryPoints: ['src/atlassian/server.ts'],
  outfile: 'dist/atlassian-server.js',
});
