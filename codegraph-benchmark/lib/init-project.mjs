#!/usr/bin/env node
// Scaffold a scenario file for a real project.
// Usage: node lib/init-project.mjs <repo-path-or-git-url> [name] [--commits N]
// Writes scenarios.<name>.json next to scenarios.json. Your working copy is never touched:
// the benchmark always works on its own clone under CORPUS_DIR.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const nIdx = args.indexOf('--commits');
const nCommits = nIdx >= 0 ? Number(args.splice(nIdx, 2)[1]) : 3;
const [src, nameArg] = args;
if (!src) {
  console.error('usage: init-project.mjs <repo-path-or-git-url> [name] [--commits N]');
  process.exit(2);
}

const isLocal = existsSync(src);
const url = isLocal ? resolve(src) : src;
const name = (nameArg || basename(url).replace(/\.git$/, '')).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();

// Read history from the local repo directly, or from a temporary bare clone of a remote.
let repoDir = url;
let tmp = null;
if (!isLocal) {
  tmp = mkdtempSync(join(tmpdir(), 'cg-init-'));
  execFileSync('git', ['clone', '-q', '--bare', '--filter=blob:none', url, tmp], { stdio: 'inherit' });
  repoDir = tmp;
}

const sha = git(repoDir, 'rev-parse', 'HEAD');
const files = git(repoDir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|swift|rb|php|scala|dart|vue|svelte)$/i;
const TEST = /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)|\.(test|spec)\.[^.]+$|_test\.(go|py)$/i;
const NOISE = /^(chore|docs|ci|build|test|style|release|revert)(\(|:|!)/i;
const codeFiles = files.filter((f) => CODE.test(f) && !TEST.test(f));

// Recent non-merge commits that touch code, with a reviewable diff size (10..400 changed lines).
const log = git(repoDir, 'log', '--no-merges', '--format=%H%x09%s', '-200', 'HEAD').split('\n').filter(Boolean);
const picked = [];
for (const line of log) {
  if (picked.length >= nCommits) break;
  const [hash, subject] = line.split('\t');
  if (NOISE.test(subject)) continue;
  let numstat;
  try { numstat = git(repoDir, 'show', '--numstat', '--format=', hash); } catch { continue; }
  const rows = numstat.split('\n').filter(Boolean).map((r) => r.split('\t'));
  const codeRows = rows.filter(([, , f]) => CODE.test(f ?? '') && !TEST.test(f));
  const changed = codeRows.reduce((n, [a, d]) => n + (Number(a) || 0) + (Number(d) || 0), 0);
  if (!codeRows.length || changed < 10 || changed > 400) continue;
  const stems = [...new Set(codeRows.map(([, , f]) => basename(f).replace(/\.[^.]+$/, '')))].slice(0, 4);
  picked.push({ hash, subject, stems, changed });
}
if (tmp) rmSync(tmp, { recursive: true, force: true });

const size = codeFiles.length < 500 ? 'small' : codeFiles.length < 5000 ? 'medium' : 'large';
const catalogue = {
  _comment: `Scenarios for ${name}. Fill in every TODO before running (preflight rejects them). 'expect' = keyword groups scored against the final answer; a group passes if ANY alternative appears.`,
  repos: { [name]: { url, sha, size, lang: 'TODO', codeFiles: codeFiles.length } },
  scenarios: [
    ...['flow', 'impact', 'architecture'].map((kind, i) => ({
      id: `${name}-a${i + 1}-${kind}`,
      repo: name,
      type: 'analysis',
      kind,
      prompt: {
        flow: 'TODO: "How does <entry point, e.g. an API request / a button click> reach <end point, e.g. the DB write / the render>? Name the functions involved in order."',
        impact: 'TODO: "If <function/class> changed its behavior, which callers and user-visible features would be affected?"',
        architecture: 'TODO: "Explain how <subsystem> works: which classes/functions participate and how they connect."',
      }[kind],
      expect: [['TODO: function or class name that a correct answer must mention'], ['TODO: another one']],
    })),
    ...picked.map((c, i) => ({
      id: `${name}-r${i + 1}-commit-${c.hash.slice(0, 7)}`,
      repo: name,
      type: 'review',
      kind: 'real-commit',
      commit: c.hash,
      _subject: c.subject,
      _changedLines: c.changed,
      expect: c.stems.map((s) => [s]),
    })),
  ],
};

const out = join(HERE, '..', `scenarios.${name}.json`);
if (existsSync(out) && !process.env.FORCE) {
  console.error(`${out} already exists (set FORCE=1 to overwrite)`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify(catalogue, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(`  repo: ${url} @ ${sha.slice(0, 7)} — ${codeFiles.length} code files (${size})`);
console.log(`  ${picked.length} real-commit review scenario(s): ${picked.map((c) => `${c.hash.slice(0, 7)} "${c.subject.slice(0, 50)}"`).join(', ') || 'none found'}`);
console.log(`  3 analysis scenarios with TODO prompts — edit them before running`);
