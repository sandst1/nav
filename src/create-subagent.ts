/**
 * /create-subagent command — generates a new subagent under `.nav/subagents/*.md`.
 */

import { join } from "node:path";

/**
 * Build the prompt sent to the main agent so it asks for missing fields and writes the file.
 *
 * @param subagentId - Optional filename stem (e.g. `code-reviewer`); lowercase, hyphens, safe for `.md` basename
 * @param purpose - Optional free-text purpose; if omitted the agent asks the user
 * @param cwd - Project root
 */
export function buildCreateSubagentPrompt(
  subagentId: string | undefined,
  purpose: string | undefined,
  cwd: string,
): string {
  const subagentsDir = join(cwd, ".nav", "subagents");

  let prompt = `Create a new **subagent** for the nav coding agent.\n\n`;
  prompt += `Subagents live at **${subagentsDir}/<id>.md**. The file stem (\`id\`) is what the parent passes as the \`agent\` argument to the \`subagent\` tool.\n\n`;

  if (subagentId) {
    prompt += `Suggested id (filename stem): **${subagentId}**\n`;
    prompt += `Normalize to a safe basename: lowercase, use hyphens instead of spaces, only letters, digits, and hyphens. If the suggestion is invalid, ask the user for a corrected id.\n\n`;
  } else {
    prompt += `Ask the user for the **subagent id** (filename stem): short, kebab-case, e.g. \`code-reviewer\` or \`research-notes\`. It becomes \`<id>.md\` under .nav/subagents/.\n\n`;
  }

  if (purpose) {
    prompt += `User's stated **purpose** (what this subagent is for):\n${purpose}\n\n`;
  } else {
    prompt += `Ask the user for the **purpose**: what this subagent should do, and when the parent agent should delegate to it (one or two sentences is enough to start).\n\n`;
  }

  prompt += `Once you have id and purpose, **you** draft:\n`;
  prompt += `- **name** — short human-readable title for the catalog (frontmatter).\n`;
  prompt += `- **description** — one line: when to delegate / what this subagent specializes in (shown in \`<available_subagents>\`).\n`;
  prompt += `- **Body** — the full system prompt / role for this subagent (tone, constraints, tools philosophy, output format). This replaces the default "You are nav…" intro for the child; project \`nav.md\`, \`AGENTS.md\`, and skills still apply after your prefix.\n\n`;

  prompt += `Then create the file:\n`;
  prompt += `1. Ensure \`${subagentsDir}\` exists (create directories as needed).\n`;
  prompt += `2. Write \`${subagentsDir}/<id>.md\` using **exactly** this shape:\n\n`;
  prompt += `\`\`\`markdown\n`;
  prompt += `---\n`;
  prompt += `name: <Short display name>\n`;
  prompt += `description: "<Single line: when the parent should call this subagent>"\n`;
  prompt += `---\n`;
  prompt += `\n`;
  prompt += `<Full role and instructions for this subagent — markdown is fine.>\n`;
  prompt += `\`\`\`\n\n`;

  prompt += `Rules:\n`;
  prompt += `- **description** must stay on one logical line in YAML (quote it if it contains colons).\n`;
  prompt += `- Do not use nested YAML; only \`name\` and \`description\` in frontmatter.\n`;
  prompt += `- After saving, tell the user the subagent id to pass to the \`subagent\` tool and that the system prompt will pick up the new entry (e.g. after /clear or on the next run if the session reloads skills/subagents).\n`;

  return prompt;
}
