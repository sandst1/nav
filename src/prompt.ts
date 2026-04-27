/**
 * System prompt builder.
 *
 * Layout (stable across handovers for KV cache preservation):
 *   1. Base system prompt (with detected tools)
 *   2. User-level nav.md (~/.config/nav/nav.md)
 *   3. Project-level nav.md (.nav/nav.md)
 *   4. AGENTS.md — project-specific instructions
 *   5. Available skills — from ~/.config/nav/skills/, .nav/skills/, .claude/skills/
 *   6. Available subagents — from .nav/subagents/*.md (unless omitted for child prompts)
 *
 * Because these files are baked in once at session start, the entire system
 * prompt stays identical after a handover, so the provider's prompt cache
 * can be reused.
 *
 * Callers that supply an external role (e.g. ui-server `systemPromptPrefix`) can
 * set `omitNavRole` to skip the default "You are nav..." identity paragraph.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadSkills } from "./skills";
import { loadSubagents, type SubagentDefinition } from "./subagents";
import type { EditMode } from "./config";

export type BuildSystemPromptOptions = {
  /** When true, omit the default Nav identity line; use when an external role prefix is prepended. */
  omitNavRole?: boolean;
  /** When set, only document tools in this list (must match nav tool names). */
  allowedToolNames?: string[];
  /** When true, skip `<available_subagents>` (used for delegated child system prompts). */
  omitSubagentCatalog?: boolean;
};

function toAllowSet(names: string[] | undefined): Set<string> | undefined {
  if (names === undefined) return undefined;
  return new Set(names);
}

function hasTool(allowed: Set<string> | undefined, name: string): boolean {
  if (allowed === undefined) return true;
  return allowed.has(name);
}

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

function buildEditModeSection(editMode: EditMode): string {
  if (editMode === "searchReplace") {
    return `Files are shown as plain text from the read tool (no line hashes).

Edit tool (each call is one edit): provide path, old_string copied exactly from a recent read, and new_string.
- old_string must match the file literally (whitespace and newlines matter).
- If old_string appears more than once, either add surrounding context so it is unique or set replace_all to true.
- new_string may be empty to delete the matched text.`;
  }
  return `Files are shown in hashline format: LINE:HASH|content
To edit, reference lines by their LINE:HASH anchor from the read output. Do not guess hashes — always read first.

Edit tool (each call is one edit):
- Replace one line: anchor="5:a3", new_text="replacement"
- Replace a range: anchor="5:a3", end_anchor="12:f1", new_text="replacement"
- Insert after a line: anchor="5:a3", new_text="new content", insert_after=true
- Delete lines: anchor="5:a3", new_text=""`;
}

function buildQuickInspectionLines(editMode: EditMode, allowed: Set<string> | undefined): string {
  const lines: string[] = [];
  if (hasTool(allowed, "skim")) {
    lines.push(
      editMode === "searchReplace"
        ? `- skim: skim(path, start_line, end_line) — line range as plain text`
        : `- skim: Read a specific line range — skim(path, start_line, end_line)`,
    );
  }
  if (hasTool(allowed, "filegrep")) {
    lines.push(
      editMode === "searchReplace"
        ? `- filegrep: filegrep(path, pattern, linesBefore?, linesAfter?) — matches with context as plain text (gaps as ...)`
        : `- filegrep: Search within a file — filegrep(path, pattern, linesBefore?, linesAfter?)`,
    );
  }
  if (lines.length === 0) return "";
  if (editMode === "hashline" && hasTool(allowed, "skim") && hasTool(allowed, "filegrep")) {
    lines.push("- Both return hashline format, so you can edit directly from the output");
  }
  return lines.join("\n");
}

function buildRulesSection(editMode: EditMode, allowed: Set<string> | undefined): string {
  const ruleLines: string[] = ["Rules:"];
  const add = (s: string) => ruleLines.push(s);

  if (editMode === "searchReplace") {
    if (hasTool(allowed, "read") || hasTool(allowed, "skim")) {
      add("- Copy text exactly from read/skim output — never invent strings for edits");
    }
    if (hasTool(allowed, "edit")) {
      add("- After editing a file, re-read it before making another edit to the same file");
      add("- Copy old_string exactly from read/skim output for the edit tool");
    }
  } else {
    if (hasTool(allowed, "read")) {
      add("- Copy LINE:HASH refs exactly from read output — never fabricate hashes");
    }
    if (hasTool(allowed, "edit")) {
      add("- new_text/text contains plain code only — no LINE:HASH| prefixes");
      add("- On hash mismatch error: use the corrected LINE:HASH refs shown in the error");
      add("- After editing a file, re-read it before making another edit to the same file");
    }
  }
  if (hasTool(allowed, "edit") || hasTool(allowed, "write")) {
    add("- Keep edits minimal — change only what's needed");
  }
  if (hasTool(allowed, "shell")) {
    add("- Use the shell tool to run commands, tests, builds, etc.");
  }
  if (hasTool(allowed, "write") && hasTool(allowed, "edit")) {
    add("- Use write tool only for new files; use edit tool for modifying existing files");
  } else if (hasTool(allowed, "write")) {
    add("- Use the write tool for new files");
  } else if (hasTool(allowed, "edit")) {
    add("- Use the edit tool for modifying existing files");
  }
  if (ruleLines.length === 1) {
    add("- Follow the user's instructions using the tools available to you.");
  }
  return ruleLines.join("\n");
}

function workStyleLine(allowed: Set<string> | undefined): string {
  if (hasTool(allowed, "read") && hasTool(allowed, "edit")) {
    return "Work in small, verifiable steps. Read before you edit. After editing, verify your changes work.";
  }
  if (hasTool(allowed, "read")) {
    return "Work in small, verifiable steps. Read files before drawing conclusions.";
  }
  if (hasTool(allowed, "edit")) {
    return "Work in small, verifiable steps. Use the edit tool only after you have accurate file content.";
  }
  return "Work in small, verifiable steps.";
}

function buildShellSection(allowed: Set<string> | undefined): string {
  if (!hasTool(allowed, "shell") && !hasTool(allowed, "shell_status")) {
    return "";
  }
  const lines: string[] = ["Shell commands:"];
  if (hasTool(allowed, "shell")) {
    lines.push("- Commands that don't finish within wait_ms get backgrounded automatically");
    lines.push("- For dev servers, watchers, or other long-running processes: set wait_ms to 0 to background immediately");
  }
  if (hasTool(allowed, "shell_status")) {
    lines.push("- Use shell_status to check on background processes, read their output, or kill them");
  }
  if (hasTool(allowed, "shell")) {
    lines.push("- The user may send messages while you're working — respond to them naturally");
  }
  return lines.join("\n");
}

function buildExplorationForAllowlist(
  allowed: Set<string> | undefined,
  sysTools: ReturnType<typeof detectTools>,
): string {
  if (!hasTool(allowed, "shell")) {
    if (hasTool(allowed, "read")) {
      return "Files & exploration:\n- The read tool returns file contents only — not directory listings.";
    }
    return "";
  }
  return buildExplorationGuide(sysTools);
}

function buildBasePrompt(
  sysTools: ReturnType<typeof detectTools>,
  editMode: EditMode,
  omitNavRole: boolean,
  allowed: Set<string> | undefined,
): string {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const parts: string[] = [];
  parts.push(`Today is ${dateStr}.`);
  parts.push("");
  parts.push(workStyleLine(allowed));

  if (hasTool(allowed, "edit")) {
    parts.push("");
    parts.push(buildEditModeSection(editMode));
  }

  const shellSec = buildShellSection(allowed);
  if (shellSec) {
    parts.push("");
    parts.push(shellSec);
  }

  const explore = buildExplorationForAllowlist(allowed, sysTools);
  if (explore) {
    parts.push("");
    parts.push(explore);
  }

  const quick = buildQuickInspectionLines(editMode, allowed);
  if (quick) {
    parts.push("");
    parts.push("Quick file inspection (no shell needed):");
    parts.push(quick);
  }

  parts.push("");
  parts.push(buildRulesSection(editMode, allowed));

  if (allowed !== undefined && allowed.size > 0) {
    parts.push("");
    parts.push(`Allowed tools in this session: ${[...allowed].sort().join(", ")}`);
  } else if (allowed !== undefined && allowed.size === 0) {
    parts.push("");
    parts.push("You have no tools enabled in this session — respond with text only.");
  }

  const body = parts.join("\n");

  const navRoleIntro = `You are nav, a coding agent. You navigate codebases, understand them, and make changes.

`;

  return omitNavRole ? body : `${navRoleIntro}${body}`;
}

function appendSubagentCatalog(
  prompt: string,
  cwd: string,
  allowed: Set<string> | undefined,
  omitCatalog: boolean,
): string {
  if (omitCatalog) return prompt;
  const subagents = loadSubagents(cwd);
  if (subagents.size === 0) return prompt;

  let block = `\n\n<available_subagents>`;
  for (const def of subagents.values()) {
    block += `\n- ${def.name}: ${def.description}`;
    block += `\n  id: ${def.id} (path: ${def.path})`;
  }
  if (hasTool(allowed, "subagent")) {
    block +=
      `\n\nTo delegate work to a subagent, call the subagent tool with "agent" set to the id above and "prompt" set to the task.`;
  } else {
    block +=
      `\n\nSubagent definitions exist in this project, but the subagent tool is not in your allowed tool list for this session — you cannot delegate.`;
  }
  block += `\n</available_subagents>`;
  return prompt + block;
}

export function buildSystemPrompt(
  cwd: string,
  editMode: EditMode = "hashline",
  options?: BuildSystemPromptOptions,
): string {
  const sysTools = detectTools();
  const allowed = toAllowSet(options?.allowedToolNames);
  let prompt = buildBasePrompt(sysTools, editMode, options?.omitNavRole ?? false, allowed);

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

  prompt = appendSubagentCatalog(prompt, cwd, allowed, options?.omitSubagentCatalog ?? false);

  return prompt;
}

/**
 * Full system prompt for a ui-server thread with an optional custom role prefix.
 * When `systemPromptPrefix` is non-empty after trim, it is prepended and the default Nav identity
 * paragraph is omitted (same as `thread.create` with `systemPromptPrefix`). Otherwise identical to
 * {@link buildSystemPrompt} — used by the CLI and threads without a custom role.
 */
export function buildSystemPromptWithOptionalRolePrefix(
  cwd: string,
  editMode: EditMode = "hashline",
  systemPromptPrefix?: string,
  options?: BuildSystemPromptOptions,
): string {
  const trimmed = systemPromptPrefix?.trim();
  if (!trimmed) {
    return buildSystemPrompt(cwd, editMode, options);
  }
  return `${trimmed}\n\n${buildSystemPrompt(cwd, editMode, { ...options, omitNavRole: true })}`;
}

/** Child system prompt: role body + shared project prompt (no default nav identity; no subagent roster). */
export function buildSubagentSystemPrompt(
  cwd: string,
  editMode: EditMode,
  definition: SubagentDefinition,
  allowedTools?: string[],
): string {
  const prefix = definition.body.trim();
  return buildSystemPromptWithOptionalRolePrefix(cwd, editMode, prefix || undefined, {
    allowedToolNames: allowedTools,
    omitSubagentCatalog: true,
  });
}

