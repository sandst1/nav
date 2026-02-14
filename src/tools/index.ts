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

const toolDefs: ToolDef[] = [readToolDef, editToolDef, writeToolDef, shellToolDef, shellStatusToolDef];

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
        result = {
          // Send the plain text message + diff to the LLM
          output: editResult.message + (editResult.diff ? `\n\n${editResult.diff}` : ""),
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
      default:
        result = {
          output: `Unknown tool: ${name}`,
          displaySummary: `unknown tool: ${name}`,
        };
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    result = {
      output: `Error: ${errMsg}`,
      displaySummary: `${name} error`,
    };
  }

  const durationMs = Math.round(performance.now() - start);
  logger.logToolResult(name, result.output, durationMs);

  if (logger.verbose) {
    result.displaySummary += ` (${durationMs}ms)`;
  }

  return result;
}
