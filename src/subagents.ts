/**
 * Subagent definitions — markdown files in `.nav/subagents/*.md`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export interface SubagentDefinition {
  /** Filename stem (e.g. `researcher` from `researcher.md`). */
  id: string;
  /** Display name from frontmatter or id. */
  name: string;
  /** Short description from frontmatter. */
  description: string;
  /** Markdown body after frontmatter — role prefix for the child agent. */
  body: string;
  /** Absolute path to the .md file. */
  path: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const empty: Frontmatter = {};
  if (!content.startsWith("---")) {
    return { frontmatter: empty, body: content.trim() };
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: empty, body: content.trim() };
  }
  const frontmatterBlock = content.slice(4, endIndex).trim();
  const body = content.slice(endIndex + 4).trim();

  const result: Frontmatter = {};
  for (const line of frontmatterBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    let value = line.slice(colonIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
  }
  return { frontmatter: result, body };
}

/**
 * Load subagent definitions from `.nav/subagents/*.md` (project only).
 */
export function loadSubagents(cwd: string): Map<string, SubagentDefinition> {
  const dir = join(cwd, ".nav", "subagents");
  const map = new Map<string, SubagentDefinition>();
  if (!existsSync(dir)) return map;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return map;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() !== ".md") continue;
    const id = basename(entry.name, ".md");
    if (!id) continue;
    const path = join(dir, entry.name);
    try {
      const content = readFileSync(path, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      map.set(id, {
        id,
        name: frontmatter.name || id,
        description: frontmatter.description || "(no description)",
        body,
        path,
      });
    } catch {
      // skip
    }
  }
  return map;
}
