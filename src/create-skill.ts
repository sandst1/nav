/**
 * /create-skill command — generates a new skill with SKILL.md.
 *
 * Creates the skill directory structure and prompts the agent to generate
 * the SKILL.md file with proper frontmatter format.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Build the prompt to send to the agent for skill creation.
 *
 * @param skillName - Name of the skill (optional, agent will ask if not provided)
 * @param location - Where to create: "project" (.nav/skills) or "user" (~/.config/nav/skills)
 * @param description - Optional description of what the skill should do
 * @param cwd - Current working directory
 */
export function buildCreateSkillPrompt(
  skillName: string | undefined,
  location: "project" | "user" | undefined,
  description: string | undefined,
  cwd: string
): string {
  const home = homedir();
  const projectSkillsDir = join(cwd, ".nav", "skills");
  const userSkillsDir = join(home, ".config", "nav", "skills");

  let prompt = `Create a new skill for the nav coding agent.\n\n`;

  // Location guidance
  if (location === "project") {
    prompt += `Location: Project-level (${projectSkillsDir}/<skill-name>/)\n`;
  } else if (location === "user") {
    prompt += `Location: User-level (${userSkillsDir}/<skill-name>/)\n`;
  } else {
    prompt += `First, ask the user where they want to create the skill:\n`;
    prompt += `  - Project-level: ${projectSkillsDir}/<skill-name>/ (available only in this project)\n`;
    prompt += `  - User-level: ${userSkillsDir}/<skill-name>/ (available in all projects)\n\n`;
  }

  // Skill name
  if (skillName) {
    prompt += `Skill name: ${skillName}\n`;
  } else {
    prompt += `Ask the user for the skill name (use lowercase with hyphens, e.g., "docx-creator").\n`;
  }

  // Description
  if (description) {
    prompt += `\nUser's description of what this skill should do:\n${description}\n`;
  } else {
    prompt += `\nAsk the user to describe what this skill should do.\n`;
  }

  prompt += `
Once you have the location, name, and description, create the skill:

1. Create the skill directory
2. Create SKILL.md with this format:

\`\`\`markdown
---
name: <skill-name>
description: "<Brief description of when to use this skill - what triggers it>"
---

# <Skill Title>

## Overview

<What this skill does and when to use it>

## Instructions

<Detailed instructions for the agent on how to use this skill>

## Examples

<Example usage scenarios>
\`\`\`

The description in frontmatter should explain WHEN to use the skill (triggers), not just what it does.
For example: "Use this skill when the user wants to create Word documents (.docx files)"

3. If the skill needs helper scripts or tools, create them in the skill directory.

After creating the skill, inform the user that:
- They can use /skills to see available skills
- The agent will automatically recognize and use the skill based on its description`;

  return prompt;
}
