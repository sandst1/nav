/**
 * Canonical nav tool names for config allowlists and validation.
 * Keep in sync with executeTool / buildToolDefs.
 */

export const NAV_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "skim",
  "filegrep",
  "shell",
  "shell_status",
  "ask_user",
  "subagent",
] as const;

export type NavToolName = (typeof NAV_TOOL_NAMES)[number];

export const NAV_TOOL_NAME_SET = new Set<string>(NAV_TOOL_NAMES);

export function isKnownNavToolName(name: string): boolean {
  return NAV_TOOL_NAME_SET.has(name);
}
