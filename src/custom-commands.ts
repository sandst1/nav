/**
 * Custom commands — user-defined slash commands loaded from markdown files.
 *
 * Locations (project-level shadows user-level):
 *   <cwd>/.nav/commands/*.md
 *   ~/.config/nav/commands/*.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface CustomCommand {
  /** Command name (filename without .md). */
  name: string;
  /** Short description extracted from the file. */
  description: string;
  /** Full markdown content used as the prompt. */
  prompt: string;
  /** Where this command was loaded from. */
  source: "project" | "user";
}

/** Extract a short description from markdown content. */
function extractDescription(content: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Use first heading text, or first non-empty line
    const heading = trimmed.match(/^#+\s+(.+)/);
    if (heading) return heading[1]!.slice(0, 60);
    // First non-heading, non-empty line
    return trimmed.slice(0, 60);
  }
  return "(no description)";
}

/** Scan a directory for .md files and return custom commands. */
function loadFromDir(dir: string, source: "project" | "user"): Map<string, CustomCommand> {
  const commands = new Map<string, CustomCommand>();
  if (!existsSync(dir)) return commands;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return commands;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = basename(entry, ".md");
    const filePath = join(dir, entry);
    try {
      const content = readFileSync(filePath, "utf-8");
      commands.set(name, {
        name,
        description: extractDescription(content),
        prompt: content,
        source,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return commands;
}

/**
 * Load custom commands from both locations.
 * Project-level commands shadow user-level commands with the same name.
 */
export function loadCustomCommands(cwd: string): Map<string, CustomCommand> {
  const home = homedir();
  const userCmds = loadFromDir(join(home, ".config", "nav", "commands"), "user");
  const projectCmds = loadFromDir(join(cwd, ".nav", "commands"), "project");

  // Merge: project overrides user
  const merged = new Map(userCmds);
  for (const [name, cmd] of projectCmds) {
    merged.set(name, cmd);
  }
  return merged;
}
