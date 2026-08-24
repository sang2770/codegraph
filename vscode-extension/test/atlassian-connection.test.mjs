import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const {
  atlassianEnvPath,
  deleteEnvFile,
  describeConnectionProblems,
  isUsableBaseUrl,
  mergeEnvValues,
  normalizeBaseUrl,
  parseEnvFile,
  readEnvFile,
  resolveConnections,
  serializeEnvFile,
  sslVerifyDisabled,
  toConnections,
  writeEnvFile,
} = loadTypeScript('atlassian/connection.ts');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'codebrain-connection-'));
}

test('parses dotenv shapes an editor or a shell profile produces', () => {
  const values = parseEnvFile(
    [
      '# a comment',
      '',
      'JIRA_URL=https://jira.example.com',
      'export CONFLUENCE_URL="https://collab.example.com/wiki"',
      "JIRA_USERNAME='sang@example.com'",
      'JIRA_PERSONAL_TOKEN="token#with-hash"',
      'CONFLUENCE_PERSONAL_TOKEN=plain-token # trailing note',
      'MALFORMED_LINE',
      '=novalue',
      '1BAD_KEY=x',
    ].join('\r\n'),
  );

  assert.equal(values.JIRA_URL, 'https://jira.example.com');
  assert.equal(values.CONFLUENCE_URL, 'https://collab.example.com/wiki');
  assert.equal(values.JIRA_USERNAME, 'sang@example.com');
  // A quoted value keeps its `#`; an unquoted one ends at the inline comment.
  assert.equal(values.JIRA_PERSONAL_TOKEN, 'token#with-hash');
  assert.equal(values.CONFLUENCE_PERSONAL_TOKEN, 'plain-token');
  assert.ok(!('MALFORMED_LINE' in values));
  assert.ok(!('1BAD_KEY' in values));
});

test('serialize/parse round-trips a token with quotes and backslashes', () => {
  const original = {
    JIRA_URL: 'https://jira.example.com',
    JIRA_PERSONAL_TOKEN: 'a"b\\c#d',
  };
  const parsed = parseEnvFile(serializeEnvFile(original));
  assert.equal(parsed.JIRA_PERSONAL_TOKEN, 'a"b\\c#d');
  assert.equal(parsed.JIRA_URL, 'https://jira.example.com');
});

test('serialization omits empty values and keeps the header comment', () => {
  const content = serializeEnvFile({ JIRA_URL: 'https://jira.example.com', JIRA_USERNAME: '' });
  assert.match(content, /^# CodeBrain/);
  assert.ok(content.includes('JIRA_URL='));
  assert.ok(!content.includes('JIRA_USERNAME'));
});

test('writeEnvFile writes atomically with owner-only permissions', (t) => {
  const dir = tempDir();
  const file = join(dir, 'nested', 'atlassian.env');

  writeEnvFile(file, { JIRA_URL: 'https://jira.example.com', JIRA_PERSONAL_TOKEN: 'tok' });

  assert.equal(readEnvFile(file).JIRA_PERSONAL_TOKEN, 'tok');
  t.diagnostic(`mode ${(statSync(file).mode & 0o777).toString(8)}`);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  // No temp file is left behind.
  assert.ok(!readFileSync(file, 'utf8').includes('undefined'));

  assert.equal(deleteEnvFile(file), true);
  assert.equal(deleteEnvFile(file), false);
  assert.deepEqual(readEnvFile(file), {});
});

test('readEnvFile tolerates a missing file', () => {
  assert.deepEqual(readEnvFile(join(tempDir(), 'absent.env')), {});
});

test('process env overrides the file, file fills the gaps', () => {
  const merged = mergeEnvValues(
    { JIRA_URL: '  https://from-env.example.com  ', UNRELATED: 'x' },
    { JIRA_URL: 'https://from-file.example.com', JIRA_PERSONAL_TOKEN: 'file-token' },
  );
  assert.equal(merged.JIRA_URL, 'https://from-env.example.com');
  assert.equal(merged.JIRA_PERSONAL_TOKEN, 'file-token');
  assert.ok(!('UNRELATED' in merged));
});

test('base URLs lose trailing slashes but keep their context path', () => {
  assert.equal(
    normalizeBaseUrl('https://collab.example.com/wiki///'),
    'https://collab.example.com/wiki',
  );
  assert.ok(isUsableBaseUrl('http://jira.internal:8080'));
  assert.ok(!isUsableBaseUrl('jira.example.com'));
  assert.ok(!isUsableBaseUrl('file:///etc/passwd'));
});

test('a product needs both a URL and a token to become usable', () => {
  const halfConfigured = {
    JIRA_URL: 'https://jira.example.com',
    CONFLUENCE_PERSONAL_TOKEN: 'tok',
  };
  const connections = toConnections(halfConfigured);
  assert.equal(connections.jira, undefined);
  assert.equal(connections.confluence, undefined);

  const problems = describeConnectionProblems(halfConfigured);
  assert.ok(problems.some((problem) => problem.includes('JIRA_PERSONAL_TOKEN is missing')));
  assert.ok(problems.some((problem) => problem.includes('CONFLUENCE_URL is missing')));
});

test('an invalid URL is reported instead of being silently dropped', () => {
  const problems = describeConnectionProblems({
    JIRA_URL: 'not-a-url',
    JIRA_PERSONAL_TOKEN: 'tok',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not a valid http\(s\) URL/);
});

test('nothing configured reports no problems', () => {
  assert.deepEqual(describeConnectionProblems({}), []);
});

test('a fully configured product carries its username through', () => {
  const connections = toConnections({
    CONFLUENCE_URL: 'https://site.atlassian.net/wiki/',
    CONFLUENCE_PERSONAL_TOKEN: 'api-token',
    CONFLUENCE_USERNAME: 'sang@example.com',
  });
  assert.deepEqual(connections.confluence, {
    baseUrl: 'https://site.atlassian.net/wiki',
    token: 'api-token',
    username: 'sang@example.com',
  });
});

test('the env path honours the override, then falls back to the home directory', () => {
  assert.equal(atlassianEnvPath({ CODEBRAIN_ATLASSIAN_ENV: '/custom/a.env' }, '/home/x'), '/custom/a.env');
  assert.equal(atlassianEnvPath({}, '/home/x'), join('/home/x', '.codebrain', 'atlassian.env'));
});

test('resolveConnections reads the override path end to end', () => {
  const file = join(tempDir(), 'atlassian.env');
  writeFileSync(file, serializeEnvFile({
    JIRA_URL: 'https://jira.example.com',
    JIRA_PERSONAL_TOKEN: 'file-token',
  }));

  const resolved = resolveConnections({ CODEBRAIN_ATLASSIAN_ENV: file }, '/nonexistent-home');
  assert.equal(resolved.envFile, file);
  assert.equal(resolved.connections.jira.token, 'file-token');
  assert.equal(resolved.connections.confluence, undefined);
});

test('TLS verification only relaxes for an explicit opt-out', () => {
  assert.equal(sslVerifyDisabled({}), false);
  assert.equal(sslVerifyDisabled({ CODEBRAIN_ATLASSIAN_SSL_VERIFY: 'true' }), false);
  assert.equal(sslVerifyDisabled({ CODEBRAIN_ATLASSIAN_SSL_VERIFY: 'False' }), true);
  assert.equal(sslVerifyDisabled({ CODEBRAIN_ATLASSIAN_SSL_VERIFY: '0' }), true);
  assert.equal(sslVerifyDisabled({ CODEBRAIN_ATLASSIAN_SSL_VERIFY: 'no' }), true);
});
