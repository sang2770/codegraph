#!/usr/bin/env node
// Put a corpus repo into the exact state a scenario needs, then sync its index.
// Usage: node lib/prepare.mjs <scenario-id|--repo name>   (prints the repo path on the last line)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = JSON.parse(readFileSync(process.env.SCENARIOS || join(HERE, '..', 'scenarios.json'), 'utf8'));
const CORPUS = process.env.CORPUS_DIR || '/tmp/codegraph-corpus';
const CG = process.env.CG_BIN || 'codegraph';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const git = (dir, ...args) => sh('git', ['-C', dir, ...args]).trim();
const log = (m) => process.stderr.write(`[prepare] ${m}\n`);

function ensureCommit(dir, url, sha) {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(CORPUS, { recursive: true });
    log(`cloning ${url}`);
    sh('git', ['clone', '-q', '--filter=blob:none', url, dir], { stdio: 'inherit' });
  }
  try {
    git(dir, 'cat-file', '-e', `${sha}^{commit}`);
  } catch {
    log(`fetching ${sha}`);
    git(dir, 'fetch', '-q', 'origin', sha);
  }
}

function hideIndexFromGit(dir) {
  const exclude = join(dir, '.git', 'info', 'exclude');
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes('.codegraph/')) writeFileSync(exclude, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + '.codegraph/\n');
}

function resetTo(dir, ref) {
  // .codegraph/ is kept so the index only needs an incremental sync.
  git(dir, 'checkout', '-q', '-f', '--detach', ref);
  git(dir, 'clean', '-q', '-fd', '-e', '.codegraph');
}

function applySeed(dir, seeds) {
  for (const { file, find, replace } of seeds) {
    const path = join(dir, file);
    const src = readFileSync(path, 'utf8');
    const hits = src.split(find).length - 1;
    if (hits !== 1) throw new Error(`seed for ${file}: expected 1 match, found ${hits} (repo moved? check sha)`);
    writeFileSync(path, src.replace(find, replace));
  }
}

function syncIndex(dir) {
  if (!existsSync(join(dir, '.codegraph'))) {
    log(`indexing ${dir} (first time, may take a while)`);
    sh(CG, ['init', dir], { stdio: 'inherit' });
  } else {
    sh(CG, ['sync', '-q', dir]);
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: prepare.mjs <scenario-id> | --repo <name>');
  process.exit(2);
}

let repoName, scenario;
if (arg === '--repo') {
  repoName = process.argv[3];
} else {
  scenario = CATALOGUE.scenarios.find((s) => s.id === arg);
  if (!scenario) throw new Error(`unknown scenario ${arg}`);
  repoName = scenario.repo;
}
const repo = CATALOGUE.repos[repoName];
if (!repo) throw new Error(`unknown repo ${repoName}`);
const dir = join(CORPUS, repoName);

ensureCommit(dir, repo.url, repo.sha);
hideIndexFromGit(dir);

if (scenario?.commit) {
  ensureCommit(dir, repo.url, scenario.commit);
  resetTo(dir, `${scenario.commit}^`);
  const diff = git(dir, 'diff', '--binary', `${scenario.commit}^`, scenario.commit) + '\n';
  execFileSync('git', ['-C', dir, 'apply'], { input: diff });
  log(`${scenario.id}: applied real commit ${scenario.commit} as uncommitted changes`);
} else {
  resetTo(dir, repo.sha);
  if (scenario?.seed) {
    applySeed(dir, scenario.seed);
    log(`${scenario.id}: applied ${scenario.seed.length} seeded edit(s)`);
  }
}

syncIndex(dir);
console.log(dir);
