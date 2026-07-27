import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  // VS Code is supplied by the extension host. PDFKit stays external because
  // it loads its AFM font metrics from package-relative data files at runtime.
  external: ['vscode', 'pdfkit'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/extension.js',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
