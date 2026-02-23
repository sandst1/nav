/**
 * @-mention expansion — inline file content into user prompts.
 *
 * Finds @path/to/file tokens in a user message and replaces each with
 * the file's content in hashline format, wrapped in <file:…> / </file> tags.
 *
 * Expansion is a single pass over the message string; the result is always
 * a string (errors are reported inline, not thrown).
 */

import { resolve } from "node:path";
import { statSync } from "node:fs";
import { formatHashLines } from "./hashline";

/** Regex matching @path tokens. Path may not contain spaces or newlines. */
export const AT_MENTION_RE = /@([^\s@]+)/g;

/** A single resolved @-mention. */
export interface AtMention {
  /** The raw token as typed, e.g. "@src/agent.ts" */
  raw: string;
  /** The resolved absolute path */
  resolvedPath: string;
  /** The path as it will appear in the <file:…> tag (relative if possible) */
  displayPath: string;
}

/** Result of expanding a single @-mention token. */
export type AtMentionExpansion =
  | { ok: true;  mention: AtMention; content: string }
  | { ok: false; mention: AtMention; error: string };

/**
 * Return true if the prompt contains at least one @-mention token.
 * Used to skip expansion overhead when there's nothing to expand.
 */
export function hasAtMentions(prompt: string): boolean {
  AT_MENTION_RE.lastIndex = 0;
  return AT_MENTION_RE.test(prompt);
}

/**
 * Parse all @-mention tokens from a prompt string without expanding them.
 * Useful for testing and for generating display hints.
 */
export function parseAtMentions(prompt: string, cwd: string): AtMention[] {
  AT_MENTION_RE.lastIndex = 0;
  const mentions: AtMention[] = [];
  let match: RegExpExecArray | null;
  while ((match = AT_MENTION_RE.exec(prompt)) !== null) {
    const raw = match[0]!;       // "@src/foo.ts"
    const pathPart = match[1]!;  // "src/foo.ts"
    const resolvedPath = pathPart.startsWith("/")
      ? pathPart
      : resolve(cwd, pathPart);
    // Display as relative when it lives under cwd, otherwise use absolute
    const displayPath = resolvedPath.startsWith(cwd + "/")
      ? resolvedPath.slice(cwd.length + 1)
      : resolvedPath;
    mentions.push({ raw, resolvedPath, displayPath });
  }
  return mentions;
}

/**
 * Expand a single @-mention token into its replacement string.
 * Reads the file at resolvedPath and formats it; returns an error on failure.
 */
export async function expandOneMention(mention: AtMention): Promise<AtMentionExpansion> {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(mention.resolvedPath);
  } catch {
    return { ok: false, mention, error: `file not found: ${mention.displayPath}` };
  }

  if (st.isDirectory()) {
    return { ok: false, mention, error: `not a file: ${mention.displayPath}` };
  }

  try {
    const text = await Bun.file(mention.resolvedPath).text();
    const content = formatHashLines(text);
    return { ok: true, mention, content };
  } catch (e) {
    return { ok: false, mention, error: `read error: ${e}` };
  }
}

/**
 * Expand all @-mentions in a prompt string.
 *
 * @param prompt - Raw user prompt (may contain @path tokens)
 * @param cwd    - Project working directory (used to resolve relative paths)
 * @returns      - The expanded prompt with file content inlined
 */
export async function expandAtMentions(prompt: string, cwd: string): Promise<string> {
  if (!hasAtMentions(prompt)) return prompt;

  const mentions = parseAtMentions(prompt, cwd);
  const expansions = await Promise.all(mentions.map(expandOneMention));

  let result = prompt;
  for (const expansion of expansions) {
    const replacement = expansion.ok
      ? `<file: ${expansion.mention.displayPath}>\n${expansion.content}\n</file>`
      : `[${expansion.error}]`;
    // Replace all occurrences of this exact raw token
    result = result.split(expansion.mention.raw).join(replacement);
  }

  return result;
}
