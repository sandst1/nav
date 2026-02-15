/**
 * /init command — generates or updates AGENTS.md for a project.
 *
 * Gathers project context (README, package.json, file tree, etc.) and returns
 * a prompt for the agent to create a comprehensive AGENTS.md file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { generateProjectTree } from "./tree";

interface ProjectContext {
  name: string;
  readme: string | null;
  packageJson: Record<string, unknown> | null;
  projectTree: string;
  hasAgentsMd: boolean;
  existingAgentsMd: string | null;
}

/** Gather context about the project to inform AGENTS.md generation. */
function gatherProjectContext(cwd: string): ProjectContext {
  const name = basename(cwd);

  // README
  let readme: string | null = null;
  for (const readmeName of ["README.md", "readme.md", "README", "Readme.md"]) {
    const readmePath = join(cwd, readmeName);
    if (existsSync(readmePath)) {
      try {
        readme = readFileSync(readmePath, "utf-8");
        // Truncate if very long
        if (readme.length > 4000) {
          readme = readme.slice(0, 4000) + "\n\n... (truncated)";
        }
        break;
      } catch {
        // Continue to next
      }
    }
  }

  // package.json (for scripts, description, etc.)
  let packageJson: Record<string, unknown> | null = null;
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      packageJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      // Ignore parse errors
    }
  }

  // Project tree
  const projectTree = generateProjectTree(cwd, {
    maxDepth: 4,
    maxEntries: 150,
    maxFilesPerDir: 12,
  });

  // Existing AGENTS.md
  const agentsPath = join(cwd, "AGENTS.md");
  const hasAgentsMd = existsSync(agentsPath);
  let existingAgentsMd: string | null = null;
  if (hasAgentsMd) {
    try {
      existingAgentsMd = readFileSync(agentsPath, "utf-8");
    } catch {
      // Ignore
    }
  }

  return {
    name,
    readme,
    packageJson,
    projectTree,
    hasAgentsMd,
    existingAgentsMd,
  };
}

/** Build the prompt to send to the agent for AGENTS.md generation. */
export function buildInitPrompt(cwd: string): string {
  const ctx = gatherProjectContext(cwd);

  let prompt = "";

  if (ctx.hasAgentsMd) {
    prompt += `The project already has an AGENTS.md file. Please UPDATE it to be current based on the project's actual state.\n\n`;
    prompt += `Current AGENTS.md:\n\`\`\`markdown\n${ctx.existingAgentsMd}\n\`\`\`\n\n`;
  } else {
    prompt += `Create a new AGENTS.md file for this project.\n\n`;
  }

  prompt += `Project name: ${ctx.name}\n\n`;

  prompt += `Project structure:\n\`\`\`\n${ctx.projectTree}\n\`\`\`\n\n`;

  if (ctx.readme) {
    prompt += `README.md:\n\`\`\`markdown\n${ctx.readme}\n\`\`\`\n\n`;
  }

  if (ctx.packageJson) {
    const { scripts, description, dependencies, devDependencies } = ctx.packageJson as {
      scripts?: Record<string, string>;
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    if (description) {
      prompt += `Package description: ${description}\n\n`;
    }

    if (scripts && Object.keys(scripts).length > 0) {
      prompt += `Available scripts (from package.json):\n`;
      for (const [name, cmd] of Object.entries(scripts)) {
        prompt += `  - npm run ${name}: ${cmd}\n`;
      }
      prompt += `\n`;
    }

    if (dependencies || devDependencies) {
      const allDeps = { ...dependencies, ...devDependencies };
      const keyDeps = Object.keys(allDeps).slice(0, 20);
      if (keyDeps.length > 0) {
        prompt += `Key dependencies: ${keyDeps.join(", ")}\n\n`;
      }
    }
  }

  prompt += `Write the AGENTS.md file with the following sections:

1. **Project Overview** — A brief description of what this project does
2. **Project Structure** — A description of the key directories and files
3. **Commands** — How to build, test, run, and develop the project
4. **Conventions** — Coding conventions, patterns, and guidelines used in this project

Keep it concise but informative. Focus on information that would help an AI coding agent understand and work with this codebase effectively.

Use the write tool to create/overwrite the AGENTS.md file in the project root.`;

  return prompt;
}
