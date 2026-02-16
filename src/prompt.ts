/**
 * System prompt builder.
 *
 * Layout (stable across handovers for KV cache preservation):
 *   1. Base system prompt (with detected tools)
 *   2. User-level nav.md (~/.config/nav/nav.md)
 *   3. Project-level nav.md (.nav/nav.md)
 *   4. AGENTS.md — project-specific instructions
 *   5. Available skills — from ~/.config/nav/skills/, .nav/skills/, .claude/skills/
 *
 * Because these files are baked in once at session start, the entire system
 * prompt stays identical after a handover, so the provider's prompt cache
 * can be reused.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadSkills } from "./skills";

/** Check if a command exists in PATH. */
function commandExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { encoding: "utf-8" });
  return result.status === 0;
}

/** Detect available search/exploration tools. */
function detectTools(): { rg: boolean; astGrep: boolean; fd: boolean; tree: boolean } {
  return {
    rg: commandExists("rg"),
    astGrep: commandExists("ast-grep") || commandExists("sg"),
    fd: commandExists("fd"),
    tree: commandExists("tree"),
  };
}

/** Build exploration guidance based on available tools. */
function buildExplorationGuide(tools: ReturnType<typeof detectTools>): string {
  const lines: string[] = [];

  lines.push("Exploration & search (use shell tool):");
  lines.push("- read tool is for file contents only — not directories");
  lines.push("- ls -la, find, or tree for directory structure");

  if (tools.rg) {
    lines.push("- rg (ripgrep) is available — prefer it over grep for fast, recursive search");
    lines.push("  Examples: rg 'pattern', rg -t py 'def foo', rg -l 'TODO'");
  } else {
    lines.push("- grep -r for recursive text search");
  }

  if (tools.fd) {
    lines.push("- fd is available — prefer it over find for finding files");
    lines.push("  Examples: fd '.ts$', fd -e py, fd -t d src");
  }

  if (tools.astGrep) {
    lines.push("- ast-grep (sg) is available — use for structural code search/refactoring");
    lines.push("  Examples: sg -p 'console.log($$$)' -l js");
  }

  if (tools.tree) {
    lines.push("- tree is available — use for visualizing directory structure");
    lines.push("  Examples: tree -L 2, tree -I node_modules");
  }

  return lines.join("\n");
}

function buildBasePrompt(tools: ReturnType<typeof detectTools>): string {
  const explorationGuide = buildExplorationGuide(tools);

  return `You are nav, a coding agent. You navigate codebases, understand them, and make changes.

Work in small, verifiable steps. Read before you edit. After editing, verify your changes work.

Files are shown in hashline format: LINE:HASH|content
To edit, reference lines by their LINE:HASH anchor from the read output. Do not guess hashes — always read first.

Edit operations:
- set_line: Replace one line. anchor="LINE:HASH", new_text="replacement content"
- replace_lines: Replace a range. start_anchor="LINE:HASH", end_anchor="LINE:HASH", new_text="replacement"
- insert_after: Insert new lines after anchor. anchor="LINE:HASH", text="new content"
- new_text="" means delete the line(s)

Shell commands:
- Commands that don't finish within wait_ms get backgrounded automatically
- For dev servers, watchers, or other long-running processes: set wait_ms to 0 to background immediately
- Use shell_status to check on background processes, read their output, or kill them
- The user may send messages while you're working — respond to them naturally

${explorationGuide}

Rules:
- Copy LINE:HASH refs exactly from read output — never fabricate hashes
- new_text/text contains plain code only — no LINE:HASH| prefixes
- On hash mismatch error: use the corrected LINE:HASH refs shown in the error
- After editing a file, re-read it before making another edit to the same file
- Keep edits minimal — change only what's needed
- Use the shell tool to run commands, tests, builds, etc.
- Use write tool only for new files; use edit tool for modifying existing files`;
}

export function buildSystemPrompt(cwd: string): string {
  const tools = detectTools();
  let prompt = buildBasePrompt(tools);

  // User-level nav.md (~/.config/nav/nav.md)
  const userNavMd = join(homedir(), ".config", "nav", "nav.md");
  if (existsSync(userNavMd)) {
    try {
      const content = readFileSync(userNavMd, "utf-8");
      prompt += `\n\n<nav_config>\n${content}\n</nav_config>`;
    } catch {
      // Ignore read errors
    }
  }

  // Project-level nav.md (.nav/nav.md)
  const projectNavMd = join(cwd, ".nav", "nav.md");
  if (existsSync(projectNavMd)) {
    try {
      const content = readFileSync(projectNavMd, "utf-8");
      prompt += `\n\n<nav_project>\n${content}\n</nav_project>`;
    } catch {
      // Ignore read errors
    }
  }

  // Load AGENTS.md if present
  const agentsPath = join(cwd, "AGENTS.md");
  if (existsSync(agentsPath)) {
    try {
      const agents = readFileSync(agentsPath, "utf-8");
      prompt += `\n\n<agents_md>\n${agents}\n</agents_md>`;
    } catch {
      // Ignore read errors
    }
  }

  // Load skills and add to prompt
  const skills = loadSkills(cwd);
  if (skills.size > 0) {
    prompt += `\n\n<available_skills>`;
    for (const [, skill] of skills) {
      prompt += `\n- ${skill.name}: ${skill.description}`;
      prompt += `\n  Path: ${skill.path}`;
    }
    prompt += `\n\nTo use a skill, read its SKILL.md file for detailed instructions.\n</available_skills>`;
  }

  return prompt;
}
