import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const DEFAULT_MAX_README_CHARACTERS = 20_000;

function findReadme(directory: string): string | undefined {
  const exact = join(directory, 'README.md');
  if (existsSync(exact)) return exact;

  try {
    const match = readdirSync(directory, { withFileTypes: true }).find(
      (entry) => entry.isFile() && entry.name.toLowerCase() === 'readme.md',
    );
    return match ? join(directory, match.name) : undefined;
  } catch {
    return undefined;
  }
}

function contextDirectories(
  root: string,
  editorContext: string,
): string[] {
  const rootPath = resolve(root);
  const activeFile = /^Active file:\s*(.+)$/m.exec(editorContext)?.[1]?.trim();
  const activePath = activeFile
    ? isAbsolute(activeFile)
      ? resolve(activeFile)
      : resolve(rootPath, activeFile)
    : rootPath;
  const insideRoot =
    activePath === rootPath ||
    activePath.startsWith(rootPath + '\\') ||
    activePath.startsWith(`${rootPath}/`);
  let directory = insideRoot ? dirname(activePath) : rootPath;
  const directories: string[] = [];

  while (true) {
    directories.push(directory);
    if (directory === rootPath) break;
    const parent = dirname(directory);
    if (parent === directory || !parent.startsWith(rootPath)) {
      directories.push(rootPath);
      break;
    }
    directory = parent;
  }
  return directories;
}

export function readProjectReadmeContext(
  root: string,
  editorContext: string,
  maxCharacters = DEFAULT_MAX_README_CHARACTERS,
): string {
  const files: string[] = [];
  for (const directory of contextDirectories(root, editorContext)) {
    const file = findReadme(directory);
    if (file && !files.includes(file)) files.push(file);
  }
  if (files.length === 0) return '';

  let remaining = Math.max(1_000, maxCharacters);
  const sections: string[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    try {
      const source = readFileSync(file, 'utf8');
      const content = source.length > remaining
        ? `${source.slice(0, remaining)}\n[README context truncated]`
        : source;
      sections.push(
        `### ${relative(resolve(root), file) || 'README.md'}\n${content}`,
      );
      remaining -= content.length;
    } catch {
      // A README is optional context; an unreadable file must not fail explain.
    }
  }

  return sections.length > 0
    ? [
        '## Project README context',
        'Use this documentation to resolve project terminology and intended behavior. When it conflicts with concrete source evidence, prefer the source and state the uncertainty.',
        ...sections,
      ].join('\n\n')
    : '';
}
