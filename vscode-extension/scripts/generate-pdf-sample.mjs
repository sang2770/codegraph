import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptRoot, '..');
const temporaryRoot = resolve(extensionRoot, 'tmp', 'pdfs');
const rendererBundle = resolve(temporaryRoot, 'pdf-renderer-sample.cjs');
const output = resolve(temporaryRoot, 'codegraph-impact-sample.pdf');

await mkdir(temporaryRoot, { recursive: true });
await build({
  entryPoints: [resolve(extensionRoot, 'src', 'pdfRenderer.ts')],
  bundle: true,
  external: ['pdfkit'],
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: rendererBundle,
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
delete require.cache[rendererBundle];
const { renderMarkdownPdf } = require(rendererBundle);
const markdown = `# Phân tích ảnh hưởng thay đổi

## Kết luận

**Mức rủi ro: HIGH.** Thay đổi chạm vào workflow xác thực có 12 thành phần phụ thuộc.

- Hợp đồng authorization có fan-out cao.
- CodeGraph phát hiện 3 test bị ảnh hưởng.

## Workflow graph

\`\`\`mermaid
flowchart LR
  A[Changed: auth.ts] --> B[Session workflow]
  B --> C[API middleware]
  C --> D[Test: auth.test.ts]
\`\`\`

## Test bị ảnh hưởng

| Test | Rủi ro | Ưu tiên |
|---|---|---:|
| test/auth.test.ts | Authorization regression | P0 |
| test/session.test.ts | Session lifecycle | P0 |
| e2e/login.spec.ts | End-to-end login | P1 |

## Tiết kiệm token (ước tính)

| Chỉ số | Giá trị |
|---|---:|
| Context CodeGraph | 2,480 tokens |
| Baseline đọc tệp | 14,900 tokens |
| Token tiết kiệm | 12,420 tokens |

> Các số token là ước tính, không phải dữ liệu billing của model.

## Release recommendation

Chạy ba test bị ảnh hưởng và review lại authorization boundary trước khi release.
`;

const pdf = await renderMarkdownPdf(markdown, {
  title: 'CodeGraph impact sample',
});
await writeFile(output, pdf);
console.log(output);
