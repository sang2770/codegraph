/**
 * The shape of a shipped `SKILL.md`, and the names of every skill the
 * extension ships.
 *
 * Its own module, with no dependency beyond the file system, because two very
 * different consumers read skills: the installer (`skillTargets.ts`, which
 * writes them into each agent's folder) and the standalone Atlassian MCP server
 * (which serves the workflow skills as MCP prompts). The server is bundled on
 * its own, so it must not drag the installer's config writers in with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillDefinition {
  /** Slug — the skill's directory name and its `name:` field. */
  name: string;
  /** Human-readable heading, from the skill's own `# Title`. */
  title: string;
  description: string;
  /** The whole `SKILL.md`, frontmatter included: Claude Code reads it as-is. */
  source: string;
  /** The instructions alone, under the frontmatter the other agents get. */
  body: string;
}

/**
 * Every skill shipped under `skills/`, general guidance first.
 *
 * `codebrain` teaches the tools; the four workflow skills are the developer
 * agent's playbooks — the same text whether an agent loads it as a skill or
 * receives it as an MCP prompt.
 */
export const CODEBRAIN_SKILL_NAMES = [
  'codebrain',
  'codebrain-explain',
  'codebrain-implement',
  'codebrain-fix',
  'codebrain-review',
] as const;

/**
 * Split a `SKILL.md` into the pieces each format needs.
 *
 * Deliberately shallow: only `name` and `description` are read, and only from
 * simple `key: value` lines. The frontmatter is authored in this repository, so
 * a full YAML parser would be a dependency bought for nothing.
 */
export function parseSkill(source: string, fallbackName: string): SkillDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const frontmatter = match?.[1] ?? '';
  const body = (match ? source.slice(match[0].length) : source).trim();

  const field = (key: string): string | undefined => {
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
    return found?.[1]?.trim().replace(/^["'](.*)["']$/, '$1');
  };

  const name = field('name') || fallbackName;
  return {
    name,
    // The body opens with the skill's own `# Heading`; use it as the title so
    // the instructions-file fallback does not invent a different name.
    title: /^#[ \t]+(.+)$/m.exec(body)?.[1]?.trim() || name,
    description: field('description') ?? '',
    source: source.trim(),
    body,
  };
}

/** Read one skill from a `skills/` directory. */
export function readSkill(skillsDirectory: string, name: string): SkillDefinition {
  return parseSkill(readFileSync(join(skillsDirectory, name, 'SKILL.md'), 'utf8'), name);
}
