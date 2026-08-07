import { ImpactAnalysis } from './impact';

interface EvidenceBlock {
  label: string;
  text: string;
  score: number;
  mandatory?: boolean;
}

function normalize(value: string): string {
  return value.replaceAll('\\', '/');
}

function trim(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit))}\n[Evidence block truncated.]`;
}

function packBlocks(blocks: EvidenceBlock[], budget: number): string {
  const selected: EvidenceBlock[] = [];
  let used = 0;
  const ordered = [
    ...blocks.filter((block) => block.mandatory),
    ...blocks.filter((block) => !block.mandatory).sort((a, b) => b.score - a.score),
  ];
  for (const block of ordered) {
    if (selected.includes(block)) continue;
    const rendered = `### ${block.label}\n${block.text}`;
    if (used + rendered.length > budget && !block.mandatory) continue;
    const remaining = budget - used;
    if (remaining <= 0) continue;
    selected.push({ ...block, text: trim(block.text, Math.max(1_000, remaining - block.label.length - 8)) });
    used += `### ${block.label}\n${selected.at(-1)?.text ?? ''}`.length;
  }
  return selected.map((block) => `### ${block.label}\n${block.text}`).join('\n\n');
}

export function buildReviewContext(
  analysis: ImpactAnalysis,
  diff: string,
  diffTruncated: boolean,
  maxCharacters: number,
): string {
  const changedFiles = analysis.changedFiles.map(normalize);
  const relatedFiles = [
    ...(analysis.dependentFiles ?? []),
    ...analysis.affectedTests,
  ].map(normalize);
  const graphLines = analysis.graphContext.split(/\r?\n/);
  const fileSignals = [...changedFiles, ...relatedFiles];
  const relevantGraph = graphLines.filter((line) =>
    fileSignals.some((file) => line.includes(file)),
  );
  const omittedFiles = changedFiles.filter(
    (file) => !analysis.graphContext.includes(file),
  );
  const diffBudget = Math.floor(maxCharacters * 0.55);
  const blocks: EvidenceBlock[] = [
    {
      label: 'Git diff',
      text: trim(diff || 'No Git diff was returned.', diffBudget),
      score: 100,
      mandatory: true,
    },
    {
      label: 'Changed files and affected tests',
      text: [
        `Changed files: ${changedFiles.join(', ') || 'none'}`,
        `Affected tests: ${analysis.affectedTests.join(', ') || 'none detected'}`,
      ].join('\n'),
      score: 95,
      mandatory: true,
    },
    {
      label: 'Dependency and workflow evidence',
      text: [
        `Direct dependents: ${analysis.directDependents ?? 'unknown'}`,
        `Transitive dependents: ${analysis.transitiveDependents ?? 'unknown'}`,
        `Total indexed dependents: ${analysis.dependentFiles?.length ?? analysis.totalDependentsTraversed}`,
        relevantGraph.join('\n') || 'No file-matched graph lines were returned.',
      ].join('\n'),
      score: 90,
      mandatory: true,
    },
    {
      label: 'CodeGraph context',
      text: analysis.graphContext || 'No graph evidence was returned.',
      score: 70,
    },
    {
      label: 'Context coverage and limits',
      text: [
        `Graph evidence matched ${changedFiles.length - omittedFiles.length}/${changedFiles.length} changed file(s).`,
        `Affected tests included: ${analysis.affectedTests.length > 0 ? 'yes' : 'none detected'}.`,
        `Git diff truncated: ${diffTruncated ? 'yes — review confidence must be reduced' : 'no'}.`,
        `Changed files without direct graph evidence: ${omittedFiles.join(', ') || 'none detected'}.`,
        'Dynamic, event-driven, external-service, or stale-index paths must be called out instead of being treated as complete.',
      ].join('\n'),
      score: 110,
      mandatory: true,
    },
  ];
  return packBlocks(blocks, Math.max(20_000, maxCharacters));
}
