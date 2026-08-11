import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const loadReports = () => loadTypeScript('reports.ts');

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

test('uses business-readable fallback diagrams for explain reports', () => {
  const { normalizeReport } = loadReports();
  const report = normalizeReport(
    'explain',
    '# Workflow explanation\n\n## Purpose\nThis report has no diagrams.',
    'checkout',
  );

  assert.match(report, /### Execution sequence/);
  assert.match(report, /User or system trigger/);
  assert.match(report, /Business workflow/);
  assert.doesNotMatch(report, /caller|callee|calling/i);
});

test('normalizes bug-fix reports with a bug-analysis title', () => {
  const { normalizeReport } = loadReports();
  const report = normalizeReport(
    'fix',
    '## Root cause\nThe refresh path drops the token.',
    'refresh failure',
  );

  assert.match(report, /^# Bug analysis and solution: refresh failure/);
  assert.match(report, /## Diagram/);
  assert.match(report, /CodeBrain blast radius/);
});

test('normalizes feature guides with a user-guide title and flow', () => {
  const { normalizeReport } = loadReports();
  const report = normalizeReport(
    'guide',
    '## How to use\n1. Enable the feature.',
    'automatic refresh',
  );

  assert.match(report, /^# User guide: automatic refresh/);
  assert.match(report, /Prerequisites/);
  assert.match(report, /Troubleshooting/);
});
