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
  const lines: string[] = [
    "Exploration (shell): read = files only; dirs: ls/find/tree.",
    tools.rg
      ? "- rg: rg PAT, rg -t py PAT, rg -l PAT (prefer over grep -r)"
      : "- Text: grep -r",
  ];

  if (tools.fd) lines.push("- fd: fd PAT, fd -e py, fd -t d DIR");
  if (tools.astGrep) lines.push("- ast-grep/sg: sg -p 'console.log($$$)' -l js");
  if (tools.tree) lines.push("- tree: tree -L 2, tree -I node_modules");

  return lines.join("\n");
}

function buildEditModeSection(editMode: EditMode): string {
  if (editMode === "searchReplace") {
    return `Plain text from read (no hashes). edit: path + old_string (exact literal from last read; whitespace matters) + new_string. Ambiguous match → more context or replace_all. Empty new_string deletes.`;
  }
  return `Hashlines: LINE:HASH|text — use anchors from read only (never guess). edit: anchor/end_anchor/new_text/insert_after; see edit tool for shapes. Stale anchor → use corrected refs from errors.`;
}

function buildQuickInspectionLines(editMode: EditMode, allowed: Set<string> | undefined): string {
  const lines: string[] = [];
  if (hasTool(allowed, "skim")) {
    lines.push(`- skim(path, start_line, end_line)${editMode === "searchReplace" ? " — plain" : ""}`);
  }
  if (hasTool(allowed, "filegrep")) {
    lines.push(`- filegrep(path, pattern, linesBefore?, linesAfter?)${editMode === "searchReplace" ? " — plain" : ""}`);
  }
  return lines.join("\n");
}

function buildRulesSection(editMode: EditMode, allowed: Set<string> | undefined): string {
  const ruleLines: string[] = ["Rules:"];
  const add = (s: string) => ruleLines.push(s);

  if (editMode === "searchReplace") {
    if (hasTool(allowed, "read") || hasTool(allowed, "skim")) {
      add("- Edits: copy literals from read/skim — never invent old_string");
    }
    if (hasTool(allowed, "edit") && !hasTool(allowed, "read") && !hasTool(allowed, "skim")) {
      add("- old_string must match file exactly");
    }
  } else {
    if (hasTool(allowed, "read")) {
      add("- LINE:HASH from read only; never fabricate");
    }
    if (hasTool(allowed, "edit")) {
      add("- new_text: plain code only (no LINE:HASH|); on mismatch use corrected anchors from error");
    }
  }
  if (hasTool(allowed, "edit") || hasTool(allowed, "write")) {
    add("- Minimal diffs");
  }
  if (hasTool(allowed, "shell")) {
    add("- Run commands via shell");
  }
  if (hasTool(allowed, "write") && hasTool(allowed, "edit")) {
    add("- write = new files; edit = existing");
  } else if (hasTool(allowed, "write")) {
    add("- write for new files");
  } else if (hasTool(allowed, "edit")) {
    add("- edit for existing files");
  }
  if (ruleLines.length === 1) {
    add("- Follow the user with available tools.");
  }
  return ruleLines.join("\n");
}

function workStyleLine(allowed: Set<string> | undefined): string {
  if (hasTool(allowed, "read") && hasTool(allowed, "edit")) {
    return "Small verifiable steps; read before edit; re-read same file before further edits; verify.";
  }
  if (hasTool(allowed, "read")) {
    return "Small steps; read before conclusions.";
  }
  if (hasTool(allowed, "edit")) {
    return "Small steps; edit only with accurate file content.";
  }
  return "Small verifiable steps.";
}

function buildShellSection(allowed: Set<string> | undefined): string {
  if (!hasTool(allowed, "shell") && !hasTool(allowed, "shell_status")) {
    return "";
  }
  const lines: string[] = ["Shell:"];
  if (hasTool(allowed, "shell")) {
    lines.push("- Exceeds wait_ms → backgrounded; wait_ms=0 for servers/watchers");
  }
  if (hasTool(allowed, "shell_status")) {
    lines.push("- shell_status: list/output/kill bg jobs");
  }
  return lines.join("\n");
}

function buildExplorationForAllowlist(
  allowed: Set<string> | undefined,
  sysTools: ReturnType<typeof detectTools>,
): string {
  if (!hasTool(allowed, "shell")) {
    if (hasTool(allowed, "read")) {
      return "Files: read = file contents only (not dirs).";
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
    parts.push("Quick inspect (no shell):");
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

  const navRoleIntro = "You are nav — navigate codebases and make changes.\n\n";

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
    block += `\n  id: ${def.id}`;
  }
  if (hasTool(allowed, "subagent")) {
    block += `\n\nDelegate: subagent tool, agent=id, prompt=task.`;
  } else {
    block += `\n\nSubagents listed but subagent tool not allowed — no delegation.`;
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
    prompt += `\n\nWhen relevant, read SKILL.md at Path.\n</available_skills>`;
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

/**
 * Child system prompt: role body + shared project prompt (no default nav identity).
 * Includes the subagent catalog only when the delegated allowlist exposes `subagent`.
 */
export function buildSubagentSystemPrompt(
  cwd: string,
  editMode: EditMode,
  definition: SubagentDefinition,
  allowedTools?: string[],
): string {
  const prefix = definition.body.trim();
  const allowSet = toAllowSet(allowedTools);
  return buildSystemPromptWithOptionalRolePrefix(cwd, editMode, prefix || undefined, {
    allowedToolNames: allowedTools,
    omitSubagentCatalog: !hasTool(allowSet, "subagent"),
  });
}

