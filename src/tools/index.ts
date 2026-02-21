/**
 * Tool registry — definitions and dispatch.
 */

import { readTool, readToolDef } from "./read";
import { editTool, editToolDef, type EditResult } from "./edit";
import { writeTool, writeToolDef } from "./write";
import { shellTool, shellToolDef } from "./shell";
import { shellStatusTool, shellStatusToolDef } from "./shell-status";
import type { ProcessManager } from "../process-manager";
import type { Logger } from "../logger";
import { colorizeDiff, diffSummary } from "../diff";

export { readToolDef, editToolDef, writeToolDef, shellToolDef, shellStatusToolDef };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Tool for asking the user a list of questions interactively (plan mode only). */
export const askUserToolDef: ToolDef = {
  name: "ask_user",
  description:
    "Ask the user a list of clarifying questions. Each question is presented one at a time and the user answers interactively. Use this when you need information from the user before you can produce a solid plan. Do not use this tool outside of plan mode.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: { type: "string" },
        description: "The list of questions to ask the user, in order.",
        minItems: 1,
      },
    },
    required: ["questions"],
  },
};

const toolDefs: ToolDef[] = [readToolDef, editToolDef, writeToolDef, shellToolDef, shellStatusToolDef, askUserToolDef];

/** Get all tool definitions. */
export function getToolDefs(): ToolDef[] {
  return toolDefs;
}

// For OpenAI-format function schemas
export function getOpenAITools() {
  return toolDefs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// For Anthropic-format tool schemas
export function getAnthropicTools() {
  return toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));
}

// For Ollama-format tool schemas (same as OpenAI function calling format)
export function getOllamaTools() {
  return toolDefs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// For Gemini-format tool schemas (function declarations)
export function getGeminiTools() {
  // Gemini expects a single object with all function declarations
  return [{
    functionDeclarations: toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

export interface ToolCallResult {
  /** Text result sent back to the LLM */
  output: string;
  /** For display in TUI */
  displaySummary: string;
  /** Full diff for verbose mode (edit tool only) */
  displayDiff?: string;
}

/** Execute a tool call and return the result. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  logger: Logger,
  processManager: ProcessManager,
): Promise<ToolCallResult> {
  const start = performance.now();
  let result: ToolCallResult;

  try {
    switch (name) {
      case "read": {
        const output = await readTool(args as any, cwd);
        result = {
          output,
          displaySummary: `read ${(args as any).path}`,
        };
        break;
      }
      case "edit": {
        const editResult: EditResult = await editTool(args as any, cwd);
        const summary = `edited ${(args as any).path} (${diffSummary(editResult.added, editResult.removed)})`;
        let output = editResult.message;
        if (editResult.diff) output += `\n\n${editResult.diff}`;
        if (editResult.updatedHashlines) {
          output += `\n\nUpdated hashes near changes:\n${editResult.updatedHashlines}`;
        }
        result = {
          output,
          displaySummary: summary,
          displayDiff: editResult.diff ? colorizeDiff(editResult.diff) : undefined,
        };
        break;
      }
      case "write": {
        const output = await writeTool(args as any, cwd);
        result = {
          output,
          displaySummary: `wrote ${(args as any).path}`,
        };
        break;
      }
      case "shell": {
        const output = await shellTool(args as any, cwd, processManager);
        result = {
          output,
          displaySummary: `shell: ${((args as any).command as string).slice(0, 60)}`,
        };
        break;
      }
      case "shell_status": {
        const output = shellStatusTool(args as any, processManager);
        result = {
          output,
          displaySummary: `shell_status${(args as any).pid ? ` pid:${(args as any).pid}` : ""}`,
        };
        break;
      }
      case "ask_user":
        // Handled by agent loop via askUserHandler — should not reach here
        result = {
          output: "ask_user is only available in plan mode.",
          displaySummary: "ask_user (unavailable)",
        };
        break;
      default:
        result = {
          output: `Unknown tool: ${name}`,
          displaySummary: `unknown tool: ${name}`,
        };
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    // Show a concise but informative error in the TUI (first line, truncated)
    const firstLine = errMsg.split("\n")[0] ?? errMsg;
    const shortErr = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
    result = {
      output: `Error: ${errMsg}`,
      displaySummary: `${name} error: ${shortErr}`,
    };
  }

  const durationMs = Math.round(performance.now() - start);
  logger.logToolResult(name, result.output, durationMs);

  if (logger.verbose) {
    result.displaySummary += ` (${durationMs}ms)`;
  }

  return result;
}
