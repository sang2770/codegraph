import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadReports() {
  const source = readFileSync(
    new URL('../src/reports.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'node:path') return { basename: () => '', join: () => '' };
    if (name === 'node:os') return { tmpdir: () => '' };
    if (name === 'vscode') return {};
    throw new Error(`Unexpected dependency: ${name}`);
  };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: localRequire,
    Buffer,
  });
  return module.exports;
}

test('repairs adjacent Mermaid subgraph terminators in explain reports', () => {
  const { normalizeReport } = loadReports();
  const raw = `# Workflow explanation

## Visual diagrams

\`\`\`mermaid
flowchart TD
  subgraph Outer
    subgraph Inner
      E[Phiên hết hạn]    endend
\`\`\`
`;

  const report = normalizeReport('explain', raw, 'session flow');

  assert.match(report, /E\[Phiên hết hạn\]\nend\nend/);
  assert.doesNotMatch(report, /endend/);
});
