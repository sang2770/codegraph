/**
 * The **Modules** view: every project in this workspace that CodeBrain has an
 * index for, plus the git submodules that still need one.
 *
 * A monorepo — and any repository with submodules — is several projects, each
 * with its own `.codegraph/`. Before this view the only way to see which of
 * them were indexed was to open the project picker, and the only way to index a
 * submodule was to open a terminal inside it. So the view lists them, says
 * which one CodeBrain is currently answering for, and carries the per-module
 * actions (initialize, refresh, rebuild, status, pin).
 *
 * Everything here is a thin shell over {@link IndexManager}: the indexing
 * itself, its progress UI and its output channel are already there, and a
 * second path into them would be a second set of behaviours to keep in sync.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { IndexManager } from './indexManager';
import { listSubmodules } from './submodules';
import {
  discoverIndexedProjects,
  getPinnedProject,
  INDEX_DATABASE,
  INDEX_DIRECTORY,
  projectFolder,
} from './workspace';

export const MODULES_VIEW_ID = 'codebrain.modules';

/**
 * An indexed project, or a git submodule that has none.
 *
 * There is no empty-state node: an empty tree is what makes VS Code show the
 * view's `viewsWelcome` content, which can carry real buttons.
 */
export type ModuleNode =
  | {
      kind: 'indexed';
      root: string;
      /** Path relative to the workspace folder, or '' at a folder's root. */
      relativePath: string;
      pinned: boolean;
      /** When the index database was last written, if it could be read. */
      indexedAt?: number;
    }
  | {
      kind: 'submodule';
      root: string;
      relativePath: string;
      checkedOut: boolean;
    };

/**
 * Path relative to the workspace folder containing it, `/`-separated.
 *
 * In a multi-root workspace the folder's name leads, because two roots can hold
 * a `packages/core` each and the rows would otherwise be indistinguishable.
 */
function workspaceRelative(root: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  if (!folder) return root;
  const path = relative(folder.uri.fsPath, root).replace(/\\/g, '/');
  const multiRoot = (vscode.workspace.workspaceFolders ?? []).length > 1;
  if (!multiRoot) return path;
  return path ? `${folder.name}/${path}` : folder.name;
}

function lastWritten(root: string): number | undefined {
  try {
    return statSync(join(root, INDEX_DIRECTORY, INDEX_DATABASE)).mtimeMs;
  } catch {
    // A `.codegraph/` with no database yet: an init that failed or is running.
    return undefined;
  }
}

/** "3m ago" / "2d ago", for an index's age. */
function relativeTime(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export class ModulesTreeProvider implements vscode.TreeDataProvider<ModuleNode> {
  private readonly didChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  refresh(): void {
    this.didChangeTreeData.fire();
  }

  getTreeItem(node: ModuleNode): vscode.TreeItem {
    const name = node.root.split(/[\\/]/).pop() || node.root;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    // The URI is what gives the row the file icon, the path in the hover and
    // "Reveal in Explorer" for free.
    item.resourceUri = vscode.Uri.file(node.root);

    if (node.kind === 'indexed') {
      const age = node.indexedAt ? `indexed ${relativeTime(node.indexedAt)}` : 'index not built yet';
      item.description = [node.relativePath || 'workspace root', node.pinned ? 'active' : undefined]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = new vscode.MarkdownString(
        [
          `**${name}** — ${age}`,
          '',
          `\`${node.root}\``,
          '',
          node.pinned
            ? 'CodeBrain answers for this project. Unpin it to follow the active editor again.'
            : 'Click to see what this index contains.',
        ].join('\n'),
      );
      item.iconPath = new vscode.ThemeIcon(
        node.pinned ? 'pass-filled' : 'database',
        node.pinned ? new vscode.ThemeColor('charts.green') : undefined,
      );
      item.contextValue = node.pinned ? 'codebrain.module.pinned' : 'codebrain.module.indexed';
      item.command = {
        command: 'codebrain.showModuleStatus',
        title: 'Show index status',
        arguments: [node],
      };
      return item;
    }

    item.description = `${node.relativePath} · not indexed`;
    item.tooltip = new vscode.MarkdownString(
      node.checkedOut
        ? [
            `**${name}** is a git submodule with no CodeBrain index.`,
            '',
            'A submodule is its own repository, so the outer index does not cover it.',
            'Click to index it.',
            '',
            `\`${node.root}\``,
          ].join('\n')
        : [
            `**${name}** is registered as a submodule but is not checked out.`,
            '',
            'Run `git submodule update --init` for it first — there is nothing on disk to index yet.',
          ].join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(
      node.checkedOut ? 'circle-outline' : 'circle-slash',
      node.checkedOut ? undefined : new vscode.ThemeColor('disabledForeground'),
    );
    item.contextValue = node.checkedOut
      ? 'codebrain.module.unindexed'
      : 'codebrain.module.absent';
    if (node.checkedOut) {
      item.command = {
        command: 'codebrain.initializeModule',
        title: 'Initialize CodeBrain',
        arguments: [node],
      };
    }
    return item;
  }

  async getChildren(element?: ModuleNode): Promise<ModuleNode[]> {
    // Flat list: nesting indexed projects under their parent would hide the
    // one thing the view is for — how many of them there are.
    if (element) return [];

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return [];

    const submodules = await this.readSubmodules();
    const indexedRoots = await this.readIndexedRoots(submodules.map((entry) => entry.path));
    const pinned = getPinnedProject();

    const nodes: ModuleNode[] = indexedRoots.map((root) => {
      const writtenAt = lastWritten(root);
      return {
        kind: 'indexed' as const,
        root,
        relativePath: workspaceRelative(root),
        pinned: pinned === root,
        ...(writtenAt !== undefined ? { indexedAt: writtenAt } : {}),
      };
    });

    for (const entry of submodules) {
      if (indexedRoots.includes(entry.path)) continue;
      nodes.push({
        kind: 'submodule',
        root: entry.path,
        relativePath: entry.relativePath,
        checkedOut: entry.checkedOut,
      });
    }

    return nodes;
  }

  /** Submodules of every open workspace folder. */
  private async readSubmodules(): Promise<
    { path: string; relativePath: string; checkedOut: boolean }[]
  > {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found = new Map<string, { path: string; relativePath: string; checkedOut: boolean }>();
    for (const folder of folders) {
      for (const entry of await listSubmodules(folder.uri.fsPath)) {
        if (!found.has(entry.path)) {
          found.set(entry.path, {
            path: entry.path,
            relativePath: entry.relativePath,
            checkedOut: entry.checkedOut,
          });
        }
      }
    }
    return [...found.values()];
  }

  /**
   * Indexed projects, sorted with each workspace folder's own root first.
   *
   * Discovery goes through the workspace search, which honours the user's
   * exclude globs — so submodule paths are re-checked on disk directly. A
   * submodule buried under an excluded directory would otherwise be reported as
   * unindexed and offered for an init it does not need.
   */
  private async readIndexedRoots(submodulePaths: readonly string[]): Promise<string[]> {
    const roots = new Set(await discoverIndexedProjects());
    for (const path of submodulePaths) {
      if (existsSync(join(path, INDEX_DIRECTORY))) roots.add(path);
    }
    const folderRoots = (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.uri.fsPath,
    );
    return [...roots].sort((left, right) => {
      const leftIsRoot = folderRoots.includes(left) ? 0 : 1;
      const rightIsRoot = folderRoots.includes(right) ? 0 : 1;
      return leftIsRoot - rightIsRoot || left.localeCompare(right);
    });
  }
}

/** The directory a command was invoked on, from a tree node or the explorer. */
function targetPaths(argument: unknown, selection?: readonly vscode.Uri[]): string[] {
  const uris = (selection ?? []).filter((uri) => uri?.scheme === 'file');
  if (uris.length > 0) return uris.map((uri) => directoryOf(uri.fsPath));
  if (argument instanceof vscode.Uri) {
    return argument.scheme === 'file' ? [directoryOf(argument.fsPath)] : [];
  }
  const node = argument as ModuleNode | undefined;
  if (node && (node.kind === 'indexed' || node.kind === 'submodule')) return [node.root];
  return [];
}

/**
 * A right-click can land on a file as easily as on a folder (the explorer menu
 * is filtered to folders, but the same command is in the palette), and an index
 * belongs to a directory — so a file resolves to the directory holding it.
 */
function directoryOf(path: string): string {
  try {
    return statSync(path).isDirectory() ? path : dirname(path);
  } catch {
    return path;
  }
}

/**
 * Wire up the modules view and everything that indexes a folder other than the
 * workspace root: the explorer's right-click entry, the submodule sweep, and
 * the per-module actions on the tree.
 */
export function registerModulesView(
  context: vscode.ExtensionContext,
  indexManager: IndexManager,
): ModulesTreeProvider {
  const provider = new ModulesTreeProvider();
  const view = vscode.window.createTreeView(MODULES_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  /** Index one directory, reporting what was already there. */
  const initializeOne = (path: string): Promise<boolean> =>
    indexManager.initialize(projectFolder(path));

  context.subscriptions.push(
    view,
    indexManager.onDidChangeIndex(() => provider.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.commands.registerCommand('codebrain.refreshModules', () => provider.refresh()),

    // Right-click a folder in the explorer. VS Code passes the clicked resource
    // first and the whole selection second, so a multi-select indexes each one.
    vscode.commands.registerCommand(
      'codebrain.initializeFolder',
      async (argument?: unknown, selection?: vscode.Uri[]) => {
        const paths = targetPaths(argument, selection);
        if (paths.length === 0) {
          void vscode.window.showWarningMessage(
            'CodeBrain: right-click a folder in the Explorer to index it.',
          );
          return;
        }
        for (const path of paths) await initializeOne(path);
      },
    ),

    vscode.commands.registerCommand('codebrain.initializeModule', (argument?: unknown) => {
      const [path] = targetPaths(argument);
      if (!path) return;
      return initializeOne(path);
    }),

    vscode.commands.registerCommand('codebrain.syncModule', (argument?: unknown) => {
      const [path] = targetPaths(argument);
      if (!path) return;
      return indexManager.sync(projectFolder(path));
    }),

    vscode.commands.registerCommand('codebrain.rebuildModule', (argument?: unknown) => {
      const [path] = targetPaths(argument);
      if (!path) return;
      return indexManager.rebuild(projectFolder(path));
    }),

    vscode.commands.registerCommand('codebrain.showModuleStatus', (argument?: unknown) => {
      const [path] = targetPaths(argument);
      if (!path) return;
      return indexManager.showStatus(projectFolder(path));
    }),

    vscode.commands.registerCommand('codebrain.pinModule', (argument?: unknown) => {
      const [path] = targetPaths(argument);
      if (!path) return;
      return indexManager.pinProject(path);
    }),

    vscode.commands.registerCommand('codebrain.unpinModule', () =>
      indexManager.pinProject(undefined),
    ),

    vscode.commands.registerCommand('codebrain.initializeSubmodules', () =>
      initializeSubmodules(indexManager),
    ),
  );

  // The index can also appear or vanish from outside VS Code — the CLI, a
  // teammate's `git clean`, another window. Watching the database file keeps the
  // list honest without polling.
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/${INDEX_DIRECTORY}/${INDEX_DATABASE}`,
    );
    const onChange = (): void => provider.refresh();
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
  } catch (error) {
    indexManager.log(
      `[modules] could not watch for index changes — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return provider;
}

/**
 * Index the workspace's git submodules.
 *
 * Multi-select with the un-indexed ones ticked, because that is what somebody
 * running this wants and re-indexing the rest would cost minutes. Submodules
 * that are registered but not checked out are listed as unavailable rather than
 * hidden, so an empty directory is explained instead of just missing.
 */
async function initializeSubmodules(indexManager: IndexManager): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage('CodeBrain: open a workspace with submodules first.');
    return;
  }

  const entries = (
    await Promise.all(folders.map((folder) => listSubmodules(folder.uri.fsPath)))
  ).flat();

  if (entries.length === 0) {
    void vscode.window.showInformationMessage(
      'CodeBrain: no git submodules were found in this workspace.',
    );
    return;
  }

  const available = entries.filter((entry) => entry.checkedOut);
  const missing = entries.filter((entry) => !entry.checkedOut);
  if (available.length === 0) {
    void vscode.window.showWarningMessage(
      `CodeBrain: ${missing.length} submodule(s) are registered but not checked out. Run "git submodule update --init" first.`,
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    available.map((entry) => ({
      label: entry.name,
      description: entry.relativePath,
      detail: entry.indexed ? 'Already indexed — re-indexing rebuilds nothing' : 'Not indexed yet',
      picked: !entry.indexed,
      path: entry.path,
      indexed: entry.indexed,
    })),
    {
      title: 'CodeBrain: Initialize Submodules',
      placeHolder: `${available.length} submodule(s) — the ones without an index are ticked`,
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (!picked || picked.length === 0) return;

  let indexed = 0;
  for (const entry of picked) {
    // `initialize` is a no-op with a message on an already-indexed project, so
    // a re-tick is harmless; it is skipped here to keep the summary truthful.
    if (entry.indexed) continue;
    if (await indexManager.initialize(projectFolder(entry.path))) indexed += 1;
  }

  if (missing.length > 0) {
    void vscode.window.showInformationMessage(
      `CodeBrain indexed ${indexed} submodule(s). ${missing.length} more are not checked out — run "git submodule update --init" to include them.`,
    );
  } else if (indexed > 0) {
    void vscode.window.showInformationMessage(
      `CodeBrain indexed ${indexed} submodule(s).`,
    );
  }
}
