import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL('../src/pdfRenderer.ts', import.meta.url),
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
vm.runInNewContext(compiled, {
  exports: module.exports,
  module,
  require,
  Buffer,
  console,
  process,
  setTimeout,
  clearTimeout,
});

const { renderMarkdownPdf } = module.exports;

test('renders structured Unicode Markdown as a valid PDF', async () => {
  const pdf = await renderMarkdownPdf(
    `# Phân tích ảnh hưởng thay đổi

## Kết luận

**Mức rủi ro: HIGH.** Workflow xác thực có thể bị ảnh hưởng.

## Affected tests

| Test | Priority |
|---|---:|
| test/auth.test.ts | P0 |

\`\`\`mermaid
flowchart LR
  A[Changed] --> B[Test]
\`\`\`

> Token values are estimates, not billing data.
`,
    { title: 'CodeGraph impact sample' },
  );
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.length > 2_000);
});
