/**
 * Project tree generator — builds a compact file tree for session context.
 *
 * Included in the system prompt so it remains stable across handovers,
 * preserving the KV cache prefix.
 *
 * Compaction strategies (no LLM, purely mechanical):
 * - Single-child directory chains are collapsed (src/utils/helpers/ on one line)
 * - Per-directory file truncation (first N files, then "+X more files")
 * - Lockfiles and other noise files are skipped
 */

import { readdirSync, readFileSync } from "node:fs";
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

/** Large generated files that add noise without navigation value */
const NOISE_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
]);

interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxFilesPerDir?: number;
}

interface FilteredEntry {
  name: string;
  isDir: boolean;
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
 *
 * Single-child directory chains are collapsed:
 *   src/utils/helpers/
 *     format.ts
 */
export function generateProjectTree(
  cwd: string,
  opts: TreeOptions = {},
): string {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 100;
  const maxFilesPerDir = opts.maxFilesPerDir ?? 8;

  const gitignorePatterns = loadGitignorePatterns(cwd);
  const lines: string[] = [];

  /** Read, filter, and sort directory entries. */
  function getEntries(dir: string): FilteredEntry[] {
    let raw;
    try {
      raw = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const entries: FilteredEntry[] = [];
    for (const entry of raw) {
      const name = entry.name;
      if (BUILTIN_IGNORE.has(name)) continue;
      if (name.startsWith(".") && name !== ".github") continue;
      if (!entry.isDirectory() && NOISE_FILES.has(name)) continue;

      const rel = relative(cwd, join(dir, name));
      const isDir = entry.isDirectory();
      if (matchesGitignore(rel, isDir, gitignorePatterns)) continue;

      entries.push({ name, isDir });
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });

    return entries;
  }

  /**
   * Collapse single-child directory chains.
   * If a directory contains exactly one child (itself a directory) and no
   * files, fold them together: src/ → utils/ → helpers/ becomes
   * "src/utils/helpers/".
   *
   * Returns [displayName, resolvedDir] where resolvedDir is the final
   * directory to recurse into.
   */
  function collapsePath(
    parentDir: string,
    name: string,
  ): [string, string] {
    let displayName = name;
    let dir = join(parentDir, name);

    while (true) {
      const entries = getEntries(dir);
      const dirs = entries.filter((e) => e.isDir);
      const files = entries.filter((e) => !e.isDir);
      const onlyChild = dirs[0];
      if (dirs.length === 1 && files.length === 0 && onlyChild) {
        displayName += "/" + onlyChild.name;
        dir = join(dir, onlyChild.name);
      } else {
        break;
      }
    }

    return [displayName, dir];
  }

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || lines.length >= maxEntries) return;

    const entries = getEntries(dir);
    const dirs = entries.filter((e) => e.isDir);
    const files = entries.filter((e) => !e.isDir);

    const indent = "  ".repeat(depth);

    // Directories (with path collapsing)
    for (const d of dirs) {
      if (lines.length >= maxEntries) break;

      const [displayName, resolvedDir] = collapsePath(dir, d.name);
      lines.push(`${indent}${displayName}/`);
      walk(resolvedDir, depth + 1);
    }

    // Files: show all at root, progressively fewer at deeper levels
    // depth 0 (root): unlimited, depth 1: maxFilesPerDir, depth 2+: fewer
    const fileLimit =
      depth === 0
        ? Infinity
        : Math.max(3, maxFilesPerDir - (depth - 1) * 2);
    const shown = Math.min(files.length, fileLimit);

    for (let i = 0; i < shown; i++) {
      if (lines.length >= maxEntries) break;
      const file = files[i]!;
      lines.push(`${indent}${file.name}`);
    }
    if (files.length > fileLimit) {
      lines.push(
        `${indent}... +${files.length - shown} more files`,
      );
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
