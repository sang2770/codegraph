import { basename } from 'node:path';
import * as vscode from 'vscode';
import { detectResponseLanguage } from './language';
import { localDay, MetricsStore } from './metrics';
import {
  buildExecutiveReport,
  DEFAULT_ASSUMPTIONS,
  renderExecutiveHtml,
  renderExecutiveMarkdown,
  RoiAssumptions,
} from './roiReport';
import { getWorkspaceFolder, workspaceLabel } from './workspace';

export function readAssumptions(config = vscode.workspace.getConfiguration('codebrain')): RoiAssumptions {
  const read = (key: keyof RoiAssumptions): number => {
    const value = config.get<number>(`roi.${key}`, DEFAULT_ASSUMPTIONS[key]);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_ASSUMPTIONS[key];
  };
  return {
    fullSuiteMinutes: read('fullSuiteMinutes'),
    affectedTestMinutes: read('affectedTestMinutes'),
    minutesSavedPerReview: read('minutesSavedPerReview'),
    minutesSavedPerFix: read('minutesSavedPerFix'),
    minutesSavedPerExplain: read('minutesSavedPerExplain'),
    minutesSavedPerImplement: read('minutesSavedPerImplement'),
    minutesSavedPerTest: read('minutesSavedPerTest'),
    minutesSavedPerPr: read('minutesSavedPerPr'),
  };
}

type Format = 'html' | 'md' | 'json';

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDay(date);
}

/**
 * `CodeBrain: Export Executive ROI Report` — the metrics this workspace has
 * recorded, rolled up into an executive summary with weekly and monthly
 * trends, saved as HTML (print it to PDF from a browser), Markdown, or JSON
 * (for adding several developers' reports into a team total).
 */
export async function exportExecutiveReport(metrics: MetricsStore): Promise<void> {
  const folder = getWorkspaceFolder();
  const range = await vscode.window.showQuickPick(
    [
      { label: 'Last 30 days', since: daysAgo(29) },
      { label: 'Last 90 days', since: daysAgo(89) },
      { label: 'This year', since: `${new Date().getFullYear()}-01-01` },
      { label: 'All recorded history', since: undefined },
    ],
    { title: 'CodeBrain: Executive ROI report — period', ignoreFocusOut: true },
  );
  if (!range) return;
  const format = await vscode.window.showQuickPick(
    [
      { label: 'HTML', description: 'Charts and tables; open in a browser and print to PDF', format: 'html' as Format },
      { label: 'Markdown', description: 'For Confluence, a wiki, or a PR', format: 'md' as Format },
      { label: 'JSON', description: 'Raw totals, for combining reports across a team', format: 'json' as Format },
    ],
    { title: 'CodeBrain: Executive ROI report — format', ignoreFocusOut: true },
  );
  if (!format) return;

  const workspace = folder ? workspaceLabel(folder) : vscode.workspace.name ?? 'workspace';
  const report = buildExecutiveReport(metrics.snapshot(), {
    workspace,
    assumptions: readAssumptions(),
    now: new Date(),
    since: range.since,
  });
  const language = detectResponseLanguage('', vscode.env.language).code;
  const content =
    format.format === 'html'
      ? renderExecutiveHtml(report, language)
      : format.format === 'md'
        ? renderExecutiveMarkdown(report, language)
        : `${JSON.stringify(report, null, 2)}\n`;

  const stamp = localDay(new Date());
  const name = `codebrain-roi-${workspace.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'}-${stamp}.${format.format}`;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder.uri, name) : undefined,
    filters:
      format.format === 'html'
        ? { HTML: ['html'] }
        : format.format === 'md'
          ? { Markdown: ['md'] }
          : { JSON: ['json'] },
    saveLabel: 'Export Report',
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));

  const open = format.format === 'html' ? 'Open in Browser' : 'Open';
  const action = await vscode.window.showInformationMessage(
    `CodeBrain ROI report exported to ${basename(target.fsPath)}.`,
    open,
  );
  if (action === 'Open in Browser') {
    await vscode.env.openExternal(target);
  } else if (action === 'Open') {
    await vscode.commands.executeCommand(
      format.format === 'md' ? 'markdown.showPreview' : 'vscode.open',
      target,
    );
  }
}
