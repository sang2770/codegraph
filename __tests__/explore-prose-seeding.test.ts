/**
 * codegraph_explore — prose seeding.
 *
 * Agents often pass the user's question verbatim ("when a user opens an order
 * ledger, how is it loaded and shown…") instead of a symbol bag. None of its
 * words is shape-precise, so named-symbol seeding adds nothing and the FTS
 * rank surfaces incidental hits (measured on a VS Code extension: the answer
 * classes never rendered and the agent fell back to Read/Grep).
 *
 * Prose seeding derives names from the prose and verifies them in the graph:
 * adjacent words compounding into a type name ("order ledger" → OrderLedger),
 * plus the prompt hook's segment matcher. It fires only when the query named
 * nothing itself, so symbol-bag and mixed queries keep their behavior.
 *
 * Also pinned: a vendored minified file (which defines every short name, all
 * co-named in one file) never seeds the named tier from bare words.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** Paths explore rendered as full-body ``**`<path>`** —`` source sections, in order. */
function sourcedFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\*\*`(.+?)`\*\* —/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

describe('codegraph_explore — prose seeding', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-prose-'));
    const w = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(testDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(testDir, rel), body);
    };

    // The answer: a model class named by two adjacent prose words.
    w('src/models/order-ledger.model.ts',
      `export class OrderLedger {\n` +
      `  private entries: string[] = [];\n` +
      `  loadEntries(raw: string): void {\n` +
      `    for (const line of raw.split('\\n')) {\n` +
      `      this.entries.push(line.trim());\n` +
      `    }\n` +
      `  }\n` +
      `  summarize(): string {\n` +
      `    return this.entries.join(',');\n` +
      `  }\n` +
      `}\n`);

    // Incidental matches on the prose's common words (panel, view, shown…).
    w('src/ui/panel-view.ts',
      `export function showPanel(): void { renderView(); }\n` +
      `export function renderView(): void { refreshView(); }\n` +
      `export function refreshView(): void { showPanel(); }\n`);

    // Vendored minified bundle: defines every short name in one file.
    w('media/vendor/grid.min.js',
      `function parse(a){return get(a)}function get(a){return load(a)}function load(a){return parse(a)}\n`);

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts', '**/*.js'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function explore(query: string): Promise<string> {
    const res = await handler.execute('codegraph_explore', { query });
    expect(res.isError).toBeFalsy();
    return res.content[0]!.text;
  }

  it('adjacent prose words that compound into a type name surface that type first', async () => {
    const text = await explore('When a user opens an order ledger, how is it loaded and shown in the panel view?');
    const files = sourcedFiles(text);
    expect(files[0]).toMatch(/order-ledger\.model\.ts$/);
  });

  it('a minified vendor file never takes the named tier from bare words', async () => {
    const text = await explore('how do we parse the order ledger and get the entries loaded');
    const files = sourcedFiles(text);
    const ledger = files.findIndex((f) => f.endsWith('order-ledger.model.ts'));
    const vendor = files.findIndex((f) => f.endsWith('grid.min.js'));
    expect(ledger).toBeGreaterThanOrEqual(0);
    if (vendor !== -1) expect(ledger).toBeLessThan(vendor);
  });

  it('a symbol-bag query is unaffected (named symbol still leads)', async () => {
    const text = await explore('showPanel renderView');
    expect(sourcedFiles(text)[0]).toMatch(/panel-view\.ts$/);
  });
});
