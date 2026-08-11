import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { buildTestCommands } = loadTypeScript('affectedTests.ts');

const EMPTY = {
  nodeDependencies: [],
  nodeScripts: [],
  packageManager: undefined,
  hasPackageJson: false,
  hasPytestConfig: false,
  hasGoMod: false,
  hasCargoToml: false,
  hasPomXml: false,
  hasGradle: false,
  hasDotnetProject: false,
  hasGemfile: false,
  hasComposerJson: false,
};

test('runs only the affected files on a runner that supports file selection', () => {
  const [first] = buildTestCommands(
    { ...EMPTY, nodeDependencies: ['vitest'], packageManager: 'npm', hasPackageJson: true },
    ['test/a.test.ts', 'test/b.test.ts'],
  );

  assert.equal(first.label, 'Vitest');
  assert.equal(first.command, 'npx vitest run test/a.test.ts test/b.test.ts');
});

test('uses the project package manager to invoke the runner', () => {
  const [pnpm] = buildTestCommands(
    { ...EMPTY, nodeDependencies: ['jest'], packageManager: 'pnpm', hasPackageJson: true },
    ['a.test.js'],
  );

  assert.equal(pnpm.command, 'pnpm exec jest a.test.js');
});

test('quotes paths that would otherwise break the command line', () => {
  const [first] = buildTestCommands(
    { ...EMPTY, nodeDependencies: ['vitest'], packageManager: 'npm' },
    ['test/my tests/a.test.ts'],
  );

  assert.equal(first.command, 'npx vitest run "test/my tests/a.test.ts"');
});

test('passes packages rather than files to go test', () => {
  const [first] = buildTestCommands({ ...EMPTY, hasGoMod: true }, [
    'internal/auth/session_test.go',
    'internal/auth/token_test.go',
    'cmd/api/main_test.go',
  ]);

  assert.equal(first.label, 'go test');
  assert.equal(first.command, 'go test ./cmd/api ./internal/auth');
});

test('says plainly when a runner cannot narrow to the affected files', () => {
  const [cargo] = buildTestCommands({ ...EMPTY, hasCargoToml: true }, ['tests/a.rs']);

  assert.equal(cargo.command, 'cargo test');
  assert.match(cargo.detail, /whole test target/);
});

test('offers the project test script last, as the broadest fallback', () => {
  const commands = buildTestCommands(
    {
      ...EMPTY,
      nodeDependencies: ['vitest'],
      nodeScripts: ['build', 'test'],
      packageManager: 'yarn',
      hasPackageJson: true,
    },
    ['a.test.ts'],
  );

  assert.equal(commands[0].label, 'Vitest');
  assert.equal(commands.at(-1).command, 'yarn test');
});

test('returns nothing to guess at when no runner is detectable', () => {
  assert.deepEqual(buildTestCommands(EMPTY, ['a.test.ts']), []);
});
