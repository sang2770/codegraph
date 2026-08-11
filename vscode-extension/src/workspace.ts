import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';

/** Directory the runtime creates for a project's index. */
export const INDEX_DIRECTORY = '.codegraph';

/** File inside {@link INDEX_DIRECTORY} that identifies a real index. */
export const INDEX_DATABASE = 'codegraph.db';

/**
 * Project the user pinned with “CodeBrain: Choose Project”. In a monorepo with
 * several indexed sub-projects there is no correct automatic answer, so an
 * explicit choice wins over the active-editor heuristic below.
 */
let pinnedProjectPath: string | undefined;

export function setPinnedProject(projectPath: string | undefined): void {
  pinnedProjectPath = projectPath ? resolve(projectPath) : undefined;
}

export function getPinnedProject(): string | undefined {
  return pinnedProjectPath;
}

function folderFor(projectPath: string, index = 0): vscode.WorkspaceFolder {
  const uri = vscode.Uri.file(projectPath);
  return {
    uri,
    name: basename(projectPath) || projectPath,
    index: vscode.workspace.getWorkspaceFolder(uri)?.index ?? index,
  };
}

/**
 * Nearest ancestor of `startPath` that holds an index, searching no higher than
 * `boundary`.
 *
 * The boundary is not optional and not a nicety. The runtime keeps its own
 * `~/.codegraph` directory for daemons and binaries, so an unbounded walk finds
 * one on virtually every machine and would resolve any unindexed project to the
 * user's home directory — which then becomes the target for `git`, `sync`,
 * `explore`, and file measurement.
 */
export function findIndexedRoot(
  startPath: string,
  boundary: string,
): string | undefined {
  const limit = resolve(boundary);
  let current = resolve(startPath);
  if (current !== limit && !current.startsWith(`${limit}${sep}`)) {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(current, INDEX_DIRECTORY))) {
      return current;
    }
    if (current === limit) {
      return undefined;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Indexed project owning a file, searched only within its workspace folder.
 * Returns undefined for files outside the open workspace.
 */
export function indexedRootForPath(filePath: string): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  if (!folder) {
    return undefined;
  }
  return findIndexedRoot(dirname(filePath), folder.uri.fsPath);
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

/**
 * The project CodeBrain should act on, in priority order:
 *
 * 1. the project the user pinned via “CodeBrain: Choose Project”;
 * 2. the nearest indexed root above the active editor (correct inside a
 *    monorepo, where each package carries its own index);
 * 3. the active editor's git root;
 * 4. the first workspace folder.
 */
export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  if (pinnedProjectPath && existsSync(pinnedProjectPath)) {
    return folderFor(pinnedProjectPath);
  }

  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri && editorUri.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(editorUri);
    if (folder) {
      const indexedRoot = findIndexedRoot(
        dirname(editorUri.fsPath),
        folder.uri.fsPath,
      );
      // Prefer a sub-project's own index over the outer workspace root so a
      // monorepo answers from the package the user is editing.
      if (indexedRoot && indexedRoot !== folder.uri.fsPath) {
        return folderFor(indexedRoot, folder.index);
      }
      const repositoryRoot = nearestGitRoot(editorUri.fsPath, folder.uri.fsPath);
      if (repositoryRoot && repositoryRoot !== folder.uri.fsPath) {
        return folderFor(repositoryRoot, folder.index);
      }
      return folder;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

/** Whether this folder owns an index the runtime can answer from. */
export function hasIndex(folder: vscode.WorkspaceFolder): boolean {
  return existsSync(join(folder.uri.fsPath, INDEX_DIRECTORY));
}

/** Whether this exact directory owns the index (rather than inheriting one). */
export function ownsIndex(folder: vscode.WorkspaceFolder): boolean {
  return existsSync(join(folder.uri.fsPath, INDEX_DIRECTORY));
}

export function workspaceLabel(folder: vscode.WorkspaceFolder): string {
  return folder.name || basename(folder.uri.fsPath);
}

/**
 * Every indexed project inside the open workspace folders.
 *
 * Discovery is by index database rather than by directory so a leftover empty
 * `.codegraph/` is not offered as a usable project.
 */
export async function discoverIndexedProjects(
  maxResults = 50,
): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return [];
  }
  const roots = new Set<string>();
  for (const folder of folders) {
    if (existsSync(join(folder.uri.fsPath, INDEX_DIRECTORY, INDEX_DATABASE))) {
      roots.add(resolve(folder.uri.fsPath));
    }
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, `**/${INDEX_DIRECTORY}/${INDEX_DATABASE}`),
      undefined,
      maxResults,
    );
    for (const match of matches) {
      // <root>/.codegraph/codegraph.db → <root>
      roots.add(resolve(dirname(dirname(match.fsPath))));
    }
  }
  return [...roots].sort();
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
