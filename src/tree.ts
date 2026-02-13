/**
 * Project tree generator — builds a compact file tree for session context.
 *
 * Computed once at session start and injected as a priming message so the LLM
 * has orientation without extra tool calls, while keeping the system prompt
 * (and its KV cache) completely stable.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Always ignored, regardless of .gitignore */
const BUILTIN_IGNORE = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "dist",
  "build",
  "out",
  ".turbo",
  ".cache",
  ".DS_Store",
  "coverage",
  ".nav",
]);

interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
}

/**
 * Generate a compact project tree string.
 *
 * Returns a newline-separated list like:
 *   src/
 *     agent.ts
 *     tools/
 *       read.ts
 *   package.json
 */
export function generateProjectTree(
  cwd: string,
  opts: TreeOptions = {},
): string {
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 200;

  const gitignorePatterns = loadGitignorePatterns(cwd);
  const lines: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || lines.length >= maxEntries) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (lines.length >= maxEntries) break;

      const name = entry.name;
      if (BUILTIN_IGNORE.has(name)) continue;
      if (name.startsWith(".") && name !== ".github") continue;

      const rel = relative(cwd, join(dir, name));
      if (matchesGitignore(rel, entry.isDirectory(), gitignorePatterns))
        continue;

      const indent = "  ".repeat(depth);

      if (entry.isDirectory()) {
        lines.push(`${indent}${name}/`);
        walk(join(dir, name), depth + 1);
      } else {
        lines.push(`${indent}${name}`);
      }
    }
  }

  walk(cwd, 0);

  if (lines.length >= maxEntries) {
    lines.push(`  ... (truncated at ${maxEntries} entries)`);
  }

  return lines.join("\n");
}

// ── .gitignore support (simplified) ──────────────────────────────────────────

interface IgnorePattern {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

function loadGitignorePatterns(cwd: string): IgnorePattern[] {
  try {
    const content = readFileSync(join(cwd, ".gitignore"), "utf-8");
    return parseGitignore(content);
  } catch {
    return [];
  }
}

function parseGitignore(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (let line of content.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }

    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }

    // Remove leading slash (anchored to root)
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);

    const regex = gitignoreToRegex(line, anchored);
    patterns.push({ pattern: line, negated, dirOnly, regex });
  }

  return patterns;
}

function gitignoreToRegex(pattern: string, anchored: boolean): RegExp {
  // Escape regex special chars except * and ?
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // Handle ** (matches any path segments)
  re = re.replace(/\*\*/g, "⟦GLOBSTAR⟧");
  // Handle * (matches anything except /)
  re = re.replace(/\*/g, "[^/]*");
  // Handle ?
  re = re.replace(/\?/g, "[^/]");
  // Restore globstar
  re = re.replace(/⟦GLOBSTAR⟧/g, ".*");

  if (anchored) {
    return new RegExp(`^${re}(/|$)`);
  }
  // Unanchored: can match anywhere in the path
  return new RegExp(`(^|/)${re}(/|$)`);
}

function matchesGitignore(
  relPath: string,
  isDir: boolean,
  patterns: IgnorePattern[],
): boolean {
  let ignored = false;

  for (const p of patterns) {
    if (p.dirOnly && !isDir) continue;
    if (p.regex.test(relPath)) {
      ignored = !p.negated;
    }
  }

  return ignored;
}
