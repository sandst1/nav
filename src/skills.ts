/**
 * Skills — agent skills loaded from SKILL.md files.
 *
 * Locations (project-level shadows user-level):
 *   <cwd>/.nav/skills/<skill-name>/SKILL.md
 *   <cwd>/.claude/skills/<skill-name>/SKILL.md
 *   ~/.config/nav/skills/<skill-name>/SKILL.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Skill {
  /** Skill name (from frontmatter or directory name). */
  name: string;
  /** Short description from frontmatter. */
  description: string;
  /** Full SKILL.md content. */
  content: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** Where this skill was loaded from. */
  source: "project" | "user";
}

interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Extracts content between --- delimiters at the start of the file.
 */
function parseFrontmatter(content: string): Frontmatter {
  const result: Frontmatter = {};

  // Check if content starts with ---
  if (!content.startsWith("---")) {
    return result;
  }

  // Find the closing ---
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return result;
  }

  const frontmatterBlock = content.slice(4, endIndex).trim();

  // Parse simple key: value pairs
  for (const line of frontmatterBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    let value = line.slice(colonIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === "name") {
      result.name = value;
    } else if (key === "description") {
      result.description = value;
    }
  }

  return result;
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md.
 */
function loadFromDir(dir: string, source: "project" | "user"): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  if (!existsSync(dir)) return skills;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = entry.name;
    const skillMdPath = join(dir, skillDir, "SKILL.md");

    if (!existsSync(skillMdPath)) continue;

    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const frontmatter = parseFrontmatter(content);

      skills.set(skillDir, {
        name: frontmatter.name || skillDir,
        description: frontmatter.description || "(no description)",
        content,
        path: skillMdPath,
        source,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/**
 * Load skills from all locations.
 * Project-level skills (.nav/skills, .claude/skills) shadow user-level skills.
 */
export function loadSkills(cwd: string): Map<string, Skill> {
  const home = homedir();

  // Load from all locations
  const userSkills = loadFromDir(join(home, ".config", "nav", "skills"), "user");
  const navSkills = loadFromDir(join(cwd, ".nav", "skills"), "project");
  const claudeSkills = loadFromDir(join(cwd, ".claude", "skills"), "project");

  // Merge: project overrides user, .nav overrides .claude
  const merged = new Map(userSkills);
  for (const [name, skill] of claudeSkills) {
    merged.set(name, skill);
  }
  for (const [name, skill] of navSkills) {
    merged.set(name, skill);
  }

  return merged;
}
