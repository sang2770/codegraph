import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri) {
    const folder = vscode.workspace.getWorkspaceFolder(editorUri);
    if (folder) {
      const repositoryRoot = nearestGitRoot(editorUri.fsPath, folder.uri.fsPath);
      if (repositoryRoot && repositoryRoot !== folder.uri.fsPath) {
        return {
          uri: vscode.Uri.file(repositoryRoot),
          name: basename(repositoryRoot),
          index: folder.index,
        };
      }
      return folder;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function nearestGitRoot(filePath: string, workspaceRoot: string): string | undefined {
  let current = dirname(filePath);
  const boundary = workspaceRoot.replace(/[\\/]$/, '').toLowerCase();
  while (current.toLowerCase().startsWith(boundary)) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function hasIndex(folder: vscode.WorkspaceFolder): boolean {
  return existsSync(join(folder.uri.fsPath, '.codegraph'));
}

export function workspaceLabel(folder: vscode.WorkspaceFolder): string {
  return folder.name || basename(folder.uri.fsPath);
}

export function activeEditorContext(
  folder: vscode.WorkspaceFolder,
  maxCharacters = 20_000,
): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return '';
  }
  const editorFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const editorPath = editor.document.uri.fsPath;
  const folderPath = folder.uri.fsPath.replace(/[\\/]$/, '');
  const relativePath = relative(folderPath, editorPath);
  if (
    !editorFolder ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes(`..${sep}..`)
  ) {
    return '';
  }

  const displayPath = relativePath || basename(editorPath);
  const selection = editor.document.getText(editor.selection);
  if (!selection) {
    return `Active file: ${displayPath}`;
  }

  const truncated =
    selection.length > maxCharacters
      ? `${selection.slice(0, maxCharacters)}\n[selection truncated]`
      : selection;
  return [
    `Active file: ${displayPath}`,
    `Selected lines: ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
    'Selected code:',
    truncated,
  ].join('\n');
}
