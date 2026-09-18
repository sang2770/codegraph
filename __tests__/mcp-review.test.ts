/**
 * Coverage for the diff-aware review context behind `codegraph_review`.
 *
 * Three layers, because each has its own failure mode:
 *   1. Diff parsing / path + ref normalization — pure, no index needed.
 *   2. Graph analysis over a real indexed project (callers outside the diff,
 *      blast radius, missing tests, ripple files).
 *   3. Breaking-change detection, which is the only part that needs git: it
 *      re-parses the pre-change blob and compares signatures.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import {
  parseUnifiedDiff,
  normalizeIndexPath,
  isSafeRef,
  isPlausibleCallSite,
  analyzeReview,
  buildReview,
} from '../src/mcp/review';
import { ToolHandler } from '../src/mcp/tools';
import type { Edge, Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// ---------------------------------------------------------------------------
// 1. Diff parsing / normalization
// ---------------------------------------------------------------------------

describe('parseUnifiedDiff', () => {
  it('extracts new-side line ranges from a -U0 hunk header', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 1111111..2222222 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -10,2 +10,3 @@',
      '+const x = 1;',
      '@@ -40,0 +41,2 @@',
      '+const y = 2;',
    ].join('\n');

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/auth.ts');
    expect(files[0]!.status).toBe('modified');
    expect(files[0]!.ranges).toEqual([
      { start: 10, end: 12 },
      { start: 41, end: 42 },
    ]);
  });

  it('anchors a pure deletion hunk (+n,0) at the deletion point', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -20,3 +19,0 @@',
      '-gone();',
    ].join('\n');

    // Nothing exists on the new side, but the surrounding symbol is still what
    // changed — a range that collapsed to nothing would map to zero symbols.
    expect(parseUnifiedDiff(diff)[0]!.ranges).toEqual([{ start: 19, end: 19 }]);
  });

  it('classifies added, deleted and renamed files', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1;',
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      '--- a/old.ts',
      '+++ /dev/null',
      'diff --git a/from.ts b/to.ts',
      'similarity index 95%',
      'rename from from.ts',
      'rename to to.ts',
    ].join('\n');

    const files = parseUnifiedDiff(diff);
    const byPath = new Map(files.map(f => [f.path, f]));
    expect(byPath.get('new.ts')!.status).toBe('added');
    // A deleted file is keyed by the path that disappeared, not /dev/null.
    expect(byPath.get('old.ts')!.status).toBe('deleted');
    expect(byPath.get('to.ts')!.status).toBe('renamed');
    expect(byPath.get('to.ts')!.oldPath).toBe('from.ts');
  });

  it('tolerates a default -U3 diff pasted from a PR API', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -5,7 +5,8 @@ export class X {',
      ' context',
      '+added',
      ' context',
    ].join('\n');
    expect(parseUnifiedDiff(diff)[0]!.ranges).toEqual([{ start: 5, end: 12 }]);
  });
});

describe('normalizeIndexPath', () => {
  const root = '/repo/app';

  it('strips an absolute project prefix and ./', () => {
    expect(normalizeIndexPath('/repo/app/src/a.ts', root)).toBe('src/a.ts');
    expect(normalizeIndexPath('./src/a.ts', root)).toBe('src/a.ts');
  });

  it('normalizes Windows separators', () => {
    expect(normalizeIndexPath('src\\a.ts', root)).toBe('src/a.ts');
  });

  it('re-bases a git-toplevel-relative path onto a sub-directory index root', () => {
    // git reports `app/src/a.ts`; the index root is /repo/app, so the index
    // stores `src/a.ts`. Without the re-base this matches zero nodes (#825).
    expect(normalizeIndexPath('app/src/a.ts', root, '/repo')).toBe('src/a.ts');
  });
});

describe('isPlausibleCallSite', () => {
  const node = (over: Partial<Node>): Node => ({
    id: 'n', kind: 'function', name: 'contains', qualifiedName: 'contains',
    filePath: 'src/mcp/review.ts', startLine: 1, endLine: 2, language: 'typescript',
    ...over,
  } as Node);
  const edge = (over: Partial<Edge> = {}): Edge => ({
    id: 'e', kind: 'calls', sourceId: 'a', targetId: 'n',
    metadata: { confidence: 0.5, resolvedBy: 'exact-match' },
    ...over,
  } as Edge);

  it('keeps same-file call sites whatever the confidence', () => {
    const target = node({ isExported: false });
    expect(isPlausibleCallSite(target, node({ id: 'c', name: 'caller' }), edge())).toBe(true);
  });

  it('drops a cross-FILE caller of a file-private symbol', () => {
    // Impossible by language rules, so the edge is a name collision the
    // resolver could not rule out — asserting on it wastes a reviewer's time.
    const target = node({ isExported: false });
    const caller = node({ id: 'c', name: 'other', filePath: 'src/other.ts' });
    expect(isPlausibleCallSite(target, caller, edge())).toBe(false);
  });

  it('drops a low-confidence name match across a LANGUAGE boundary', () => {
    const target = node({ isExported: true });
    const caller = node({ id: 'c', name: 'flush', filePath: 'codegraph-kernel/src/go.rs' });
    expect(isPlausibleCallSite(target, caller, edge())).toBe(false);
    // Same collision, but confidently resolved → still a real call site.
    expect(isPlausibleCallSite(target, caller, edge({ metadata: { confidence: 0.9 } }))).toBe(true);
  });

  it('keeps synthesized edges, which legitimately cross languages', () => {
    const target = node({ isExported: true });
    const caller = node({ id: 'c', name: 'Tpl', filePath: 'src/App.vue' });
    expect(
      isPlausibleCallSite(target, caller, edge({ provenance: 'heuristic', metadata: { synthesizedBy: 'vue-handler' } })),
    ).toBe(true);
  });

  it('never treats a container node as a call site', () => {
    const target = node({ isExported: true });
    const file = node({ id: 'f', kind: 'file', name: 'api.ts', filePath: 'src/api.ts' });
    expect(isPlausibleCallSite(target, file, edge({ metadata: { confidence: 1 } }))).toBe(false);
  });
});

describe('isSafeRef', () => {
  it('accepts real refs', () => {
    for (const ref of ['origin/main', 'HEAD~1', 'HEAD^', 'v1.2.3', 'abc123def', 'feat/x@{1}']) {
      expect(isSafeRef(ref)).toBe(true);
    }
  });

  it('rejects anything git would read as an option or a shell payload', () => {
    for (const ref of ['--upload-pack=touch /tmp/pwn', '-x', 'main; rm -rf /', 'a b', '$(id)']) {
      expect(isSafeRef(ref)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Graph analysis over a real index
// ---------------------------------------------------------------------------

/** A tiny TS project: a service, two callers, one test covering only one path. */
function writeProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '__tests__'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'src/service.ts'),
    [
      'export function login(email: string): string {',
      '  return email;',
      '}',
      '',
      'export function logout(token: string): boolean {',
      '  return Boolean(token);',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'src/api.ts'),
    [
      "import { login } from './service';",
      '',
      'export function handleLogin(email: string): string {',
      '  return login(email);',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'src/cli.ts'),
    [
      "import { login } from './service';",
      '',
      'export function main(): string {',
      '  return login("a@b.c");',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, '__tests__/logout.test.ts'),
    [
      "import { logout } from '../src/service';",
      '',
      'export function testLogout(): boolean {',
      '  return logout("t");',
      '}',
      '',
    ].join('\n'),
  );
}

describe('analyzeReview over an indexed project', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('maps changed lines to symbols and finds callers OUTSIDE the diff', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Only service.ts is in the change set — api.ts and cli.ts are not.
    const report = await analyzeReview(cg, {
      diff: [
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -1,3 +1,3 @@',
        '+  return email;',
      ].join('\n'),
    });

    const login = report.symbols.find(s => s.node.name === 'login');
    expect(login, 'the changed hunk should resolve to the login function').toBeDefined();
    // The hunk sits inside login only — logout must not be pulled in.
    expect(report.symbols.some(s => s.node.name === 'logout')).toBe(false);

    const externalFiles = login!.externalCallers.map(c => c.node.filePath).sort();
    expect(externalFiles).toContain('src/api.ts');
    expect(externalFiles).toContain('src/cli.ts');

    // The ripple section is the thing a plain diff can never show.
    const ripplePaths = report.rippleFiles.map(r => r.path);
    expect(ripplePaths).toContain('src/api.ts');
    expect(ripplePaths).toContain('src/cli.ts');
    expect(ripplePaths, 'files in the diff are not ripple').not.toContain('src/service.ts');

    cg.destroy();
  });

  it('flags a changed symbol that no test reaches', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const report = await analyzeReview(cg, { files: ['src/service.ts'] });
    const login = report.symbols.find(s => s.node.name === 'login');
    const logout = report.symbols.find(s => s.node.name === 'logout');
    expect(login).toBeDefined();
    expect(logout).toBeDefined();

    // logout IS covered (there is a test calling it); login is not.
    expect(logout!.coveringTests.some(t => t.includes('logout.test.ts'))).toBe(true);
    expect(login!.coveringTests).toHaveLength(0);

    const missing = report.findings.filter(f => f.kind === 'missing-test').map(f => f.symbol);
    expect(missing.some(s => s.includes('login'))).toBe(true);
    expect(missing.some(s => s.includes('logout'))).toBe(false);

    // The affected-tests list is what a CI step runs.
    expect(report.affectedTests.some(t => t.includes('logout.test.ts'))).toBe(true);

    cg.destroy();
  });

  it('defaults to structure only — no source echoed back', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const cheap = await buildReview(cg, { files: ['src/service.ts'] });
    expect(cheap).toContain('Changed symbols and their call sites');
    expect(cheap, 'the reviewer already holds the diff').not.toContain('```');

    const withSource = await buildReview(cg, { files: ['src/service.ts'], includeSource: 'changed' });
    expect(withSource).toContain('```');
    expect(withSource.length).toBeGreaterThan(cheap.length);

    cg.destroy();
  });

  it('honors maxChars with a line-boundary cut', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Enough callers that the uncapped report comfortably exceeds the cap.
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(
        path.join(tmpDir!, `src/caller${i}.ts`),
        [
          "import { login } from './service';",
          '',
          `export function caller${i}(): string {`,
          '  return login("a@b.c");',
          '}',
          '',
        ].join('\n'),
      );
    }
    await cg.indexAll();

    const full = await buildReview(cg, { files: ['src/service.ts'], maxCallers: 40 });
    const capped = await buildReview(cg, { files: ['src/service.ts'], maxCallers: 40, maxChars: 2000 });
    expect(full.length).toBeGreaterThan(2000);
    expect(capped.length).toBeLessThan(full.length);
    expect(capped).toContain('report truncated');
    // The footer is the line that keeps a reviewer off Read, so it is appended
    // after the cut instead of being its first casualty.
    expect(capped).toContain('codegraph_explore');

    cg.destroy();
  });

  it('emits JSON for a programmatic consumer', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const parsed = JSON.parse(await buildReview(cg, { files: ['src/service.ts'], format: 'json' }));
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.symbols.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining([expect.stringContaining('login')]),
    );

    cg.destroy();
  });

  it('sees a test that calls the symbol from inside an it() callback', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    // No enclosing named function: the call sits in a callback, so the graph
    // records it against the FILE node. Excluding container nodes as
    // bookkeeping hid exactly this, and "no test reaches this symbol" then
    // fired on a symbol a test does reach.
    fs.writeFileSync(
      path.join(tmpDir, '__tests__/login.test.ts'),
      [
        "import { login } from '../src/service';",
        '',
        "it('logs in', () => {",
        '  login("a@b.c");',
        '});',
        '',
      ].join('\n'),
    );
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const report = await analyzeReview(cg, { files: ['src/service.ts'] });
    const login = report.symbols.find(s => s.node.name === 'login')!;
    expect(login.coveringTests.some(t => t.includes('login.test.ts'))).toBe(true);
    expect(report.findings.some(f => f.kind === 'missing-test' && f.symbol.includes('login'))).toBe(false);
    expect(report.affectedTests.some(t => t.includes('login.test.ts'))).toBe(true);

    cg.destroy();
  });

  it('counts a blast radius the listed call sites actually back', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const report = await analyzeReview(cg, { files: ['src/service.ts'] });
    const login = report.symbols.find(s => s.node.name === 'login')!;

    // login is called by handleLogin (api.ts) and main (cli.ts); nothing calls
    // those. The number a reviewer reads has to agree with the evidence under
    // it, so it walks the same plausibility rule as the caller list rather than
    // the raw edge table.
    expect(login.callers.map(c => c.node.name).sort()).toEqual(['handleLogin', 'main']);
    expect(login.blastRadius).toBe(2);

    const logout = report.symbols.find(s => s.node.name === 'logout')!;
    expect(logout.blastRadius).toBe(logout.callers.length);

    cg.destroy();
  });

  it('expands a directory entry in `files`, which is what its own advice hands back', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const byDir = await analyzeReview(cg, { files: ['src/'] });
    const paths = byDir.changedFiles.map(f => f.path).sort();
    expect(paths).toEqual(['src/api.ts', 'src/cli.ts', 'src/service.ts']);
    expect(byDir.notes.join('\n')).toContain('expanded');
    // A directory without the trailing slash works the same way.
    expect((await analyzeReview(cg, { files: ['src'] })).changedFiles).toHaveLength(3);
    // A path that is neither file nor directory is kept, so the note names it.
    const bogus = await analyzeReview(cg, { files: ['src/nope.ts'] });
    expect(bogus.changedFiles.map(f => f.path)).toEqual(['src/nope.ts']);

    cg.destroy();
  });

  it('names the files a maxSymbols cap left unexamined', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // A count alone leaves the caller guessing which part of the change set
    // went unexamined; the note has to be a next step.
    const report = await analyzeReview(cg, { files: ['src/'], maxSymbols: 1 });
    const note = report.notes.find(n => n.includes('maxSymbols'))!;
    expect(note).toContain('calling again with files:');
    expect(note).toMatch(/src\/(api|cli|service)\.ts/);

    cg.destroy();
  });

  it('keeps a symbol the hunk only overlaps alongside one it fully contains', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // One hunk, both shapes at once: it covers all of `logout` (L5-7) and the
    // tail of `login` (L1-3). Keeping only the fully-contained symbol dropped
    // the edited one from the report entirely.
    const report = await analyzeReview(cg, {
      diff: [
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -3,5 +3,5 @@',
        '+  return email;',
      ].join('\n'),
    });

    const names = report.symbols.map(s => s.node.name).sort();
    expect(names).toContain('logout');
    expect(names, 'the partially-touched symbol must survive too').toContain('login');

    cg.destroy();
  });

  it('holds the JSON report to the same budget as markdown, and keeps it parseable', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(
        path.join(tmpDir!, `src/caller${i}.ts`),
        [
          "import { login } from './service';",
          '',
          `export function caller${i}(): string {`,
          '  return login("a@b.c");',
          '}',
          '',
        ].join('\n'),
      );
    }
    await cg.indexAll();

    const opts = { files: ['src/service.ts'], maxCallers: 40, format: 'json' as const };
    const full = await buildReview(cg, opts);
    const capped = await buildReview(cg, { ...opts, maxChars: 2500 });

    expect(full.length).toBeGreaterThan(2500);
    expect(capped.length).toBeLessThanOrEqual(2500);
    // Cutting JSON text would hand back something that no longer parses, so the
    // budget is met by dropping symbol detail — findings always survive.
    const parsed = JSON.parse(capped);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.symbolCount).toBeGreaterThan(parsed.symbols.length);
    expect(parsed.notes.join('\n')).toContain('trimmed');

    cg.destroy();
  });

  it('returns guidance, not an error, when nothing changed', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const out = await buildReview(cg, { files: [] , diff: '' });
    expect(out).toContain('No changed files were detected');
    expect(out).toContain('not an error');

    cg.destroy();
  });
});

// ---------------------------------------------------------------------------
// 2b. The MCP argument surface (what clients actually send)
// ---------------------------------------------------------------------------

describe('codegraph_review tool arguments', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const runTool = async (dir: string, args: Record<string, unknown>) => {
    const cg = fs.existsSync(path.join(dir, '.codegraph'))
      ? CodeGraph.openSync(dir)
      : CodeGraph.initSync(dir);
    await cg.indexAll();
    const res = await new ToolHandler(cg).execute('codegraph_review', args);
    cg.destroy();
    return res;
  };

  it('accepts `files` as a real array as well as a comma-separated string', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-args-'));
    writeProject(tmpDir);

    // MCP clients serialize arrays inconsistently. Taking only the string form
    // meant an array was silently dropped and the tool reviewed the working-tree
    // diff instead — a wrong answer the caller had no way to notice.
    const asArray = await runTool(tmpDir, { files: ['src/service.ts'] });
    const asString = await runTool(tmpDir, { files: 'src/service.ts' });
    for (const res of [asArray, asString]) {
      expect(res.isError ?? false).toBe(false);
      expect(res.content[0]!.text).toContain('src/service.ts');
      expect(res.content[0]!.text).toContain('login');
    }
    expect(asArray.content[0]!.text).toBe(asString.content[0]!.text);
  });

  it('splits a newline-separated `git diff --name-only` paste', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-args-'));
    writeProject(tmpDir);
    const res = await runTool(tmpDir, { files: 'src/service.ts\nsrc/api.ts' });
    expect(res.content[0]!.text).toContain('src/service.ts');
    expect(res.content[0]!.text).toContain('src/api.ts');
  });

  it('says so instead of silently reviewing something else when `files` is unusable', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-args-'));
    writeProject(tmpDir);
    const res = await runTool(tmpDir, { files: [] });
    expect(res.isError ?? false, 'a bad argument is the caller’s typo, not a malfunction').toBe(false);
    expect(res.content[0]!.text).toContain('`files` was supplied');
  });

  it('honors an explicit maxChars — the knob the truncation message names', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-args-'));
    writeProject(tmpDir);
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `src/caller${i}.ts`),
        [
          "import { login } from './service';",
          '',
          `export function caller${i}(): string {`,
          '  return login("a@b.c");',
          '}',
          '',
        ].join('\n'),
      );
    }
    const capped = await runTool(tmpDir, { files: ['src/service.ts'], maxCallers: 40, maxChars: 2200 });
    const roomy = await runTool(tmpDir, { files: ['src/service.ts'], maxCallers: 40 });
    expect(capped.content[0]!.text.length).toBeLessThan(roomy.content[0]!.text.length);
    expect(capped.content[0]!.text).toContain('report truncated');
  });
});

// ---------------------------------------------------------------------------
// 3. Breaking-change detection (needs git)
// ---------------------------------------------------------------------------

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

describe.runIf(hasGit())('breaking-change detection against a base ref', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('flags a signature change whose call sites are outside the diff', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-git-'));
    writeProject(tmpDir);
    git(tmpDir, ['init']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test']);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'baseline']);

    // Change login's signature but leave both callers untouched.
    fs.writeFileSync(
      path.join(tmpDir, 'src/service.ts'),
      [
        'export function login(email: string, otp: string): string {',
        '  return email + otp;',
        '}',
        '',
        'export function logout(token: string): boolean {',
        '  return Boolean(token);',
        '}',
        '',
      ].join('\n'),
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const report = await analyzeReview(cg, { base: 'HEAD' });

    const breaking = report.findings.find(f => f.kind === 'breaking-signature');
    expect(breaking, 'signature drift vs HEAD should be detected').toBeDefined();
    expect(breaking!.symbol).toContain('login');
    expect(breaking!.severity).toBe('high');
    // Evidence must name the call sites the change did NOT update.
    expect(breaking!.evidence.join('\n')).toContain('src/api.ts');
    expect(breaking!.evidence.join('\n')).toContain('src/cli.ts');

    const login = report.symbols.find(s => s.node.name === 'login');
    expect(login!.oldSignature).toBeDefined();
    expect(login!.oldSignature).not.toBe(login!.node.signature);

    cg.destroy();
  });

  it('flags an exported symbol that was removed, naming the importers to check', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-git-'));
    writeProject(tmpDir);
    git(tmpDir, ['init']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test']);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'baseline']);

    // Drop `logout` entirely; its test still imports the module.
    fs.writeFileSync(
      path.join(tmpDir, 'src/service.ts'),
      ['export function login(email: string): string {', '  return email;', '}', ''].join('\n'),
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const report = await analyzeReview(cg, { base: 'HEAD' });
    const removed = report.findings.find(f => f.kind === 'removed-symbol');
    expect(removed, 'a vanished export is a contract break').toBeDefined();
    expect(removed!.symbol).toContain('logout');
    // The call in the test file can no longer resolve to any definition, so it
    // is provable evidence — not just "this file imports the module".
    expect(removed!.evidence.join('\n')).toContain('logout.test.ts');
    expect(removed!.severity).toBe('high');

    cg.destroy();
  });

  it('warns when `head` names a ref the working tree is not at', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-git-'));
    writeProject(tmpDir);
    git(tmpDir, ['init']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test']);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'baseline']);

    // A second commit, so HEAD~1...HEAD is a real range to review.
    fs.writeFileSync(
      path.join(tmpDir, 'src/service.ts'),
      [
        'export function login(email: string, otp: string): string {',
        '  return email + otp;',
        '}',
        '',
        'export function logout(token: string): boolean {',
        '  return Boolean(token);',
        '}',
        '',
      ].join('\n'),
    );
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'change']);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Working tree IS head for the reviewed files → the after side is honest.
    const clean = await analyzeReview(cg, { base: 'HEAD~1', head: 'HEAD' });
    expect(clean.warnings.join('\n')).not.toContain('AFTER side');

    // Now the working tree — which is what the index describes, and where every
    // "after" fact comes from — is no longer that ref.
    fs.writeFileSync(
      path.join(tmpDir, 'src/service.ts'),
      [
        'export function login(email: string, otp: string, trace: boolean): string {',
        '  return email + otp + String(trace);',
        '}',
        '',
      ].join('\n'),
    );
    await cg.indexAll();

    const drifted = await analyzeReview(cg, { base: 'HEAD~1', head: 'HEAD' });
    expect(drifted.warnings.join('\n')).toContain('AFTER side');

    cg.destroy();
  });

  it('does not call a brand-new interface a contract change', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-git-'));
    writeProject(tmpDir);
    git(tmpDir, ['init']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test']);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'baseline']);

    // A new file of new interfaces: nothing implements them yet, so "every
    // implementor has to agree" is not a claim about anything.
    fs.writeFileSync(
      path.join(tmpDir, 'src/types.ts'),
      [
        'export interface Credentials { user: string; pass: string; }',
        '',
        'export interface Profile { id: string; }',
        '',
      ].join('\n'),
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const report = await analyzeReview(cg, { base: 'HEAD' });
    expect(report.symbols.filter(s => s.node.kind === 'interface').every(s => s.isNew)).toBe(true);
    expect(report.findings.some(f => f.kind === 'public-surface-change')).toBe(false);
    // Types carry no runtime behavior, so "no test reaches it" says nothing.
    expect(report.findings.some(f => f.kind === 'missing-test' && f.symbol.includes('Credentials'))).toBe(false);

    cg.destroy();
  });

  it('says so explicitly when no base ref was given', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-review-git-'));
    writeProject(tmpDir);
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // A caller that handed us a change set from elsewhere is reviewing a PR, so
    // losing every HIGH finding is a WARNING (rendered above the findings), not
    // a note at the bottom that the char cap can cut.
    const supplied = await analyzeReview(cg, { files: ['src/service.ts'] });
    expect(supplied.warnings.join('\n')).toContain('No `base` ref was given');
    expect(supplied.warnings.join('\n')).toContain('together with');

    // Reviewing uncommitted work without a base is ordinary, so it stays a note.
    const uncommitted = await analyzeReview(cg, {});
    expect(uncommitted.notes.join('\n')).toContain('breaking-change detection');
    expect(uncommitted.warnings).toHaveLength(0);

    cg.destroy();
  });
});
