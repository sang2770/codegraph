import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri) {
    const folder = vscode.workspace.getWorkspaceFolder(editorUri);
    if (folder) {
      return folder;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
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
  if (editorFolder?.uri.toString() !== folder.uri.toString()) {
    return '';
  }

  const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
  const selection = editor.document.getText(editor.selection);
  if (!selection) {
    return `Active file: ${relativePath}`;
  }

  const truncated =
    selection.length > maxCharacters
      ? `${selection.slice(0, maxCharacters)}\n[selection truncated]`
      : selection;
  return [
    `Active file: ${relativePath}`,
    `Selected lines: ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
    'Selected code:',
    truncated,
  ].join('\n');
}
