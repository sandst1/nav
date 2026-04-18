/**
 * Tool registry — definitions and dispatch.
 */

import { readTool, readToolDefHashline, readToolDefSearchReplace } from "./read";
import { editTool, editToolDefHashline, editToolDefSearchReplace, type EditResult } from "./edit";
import { writeTool, writeToolDef } from "./write";
import { shellTool, shellToolDef } from "./shell";
import { shellStatusTool, shellStatusToolDef } from "./shell-status";
import {
  skimTool,
  skimToolDefHashline,
  skimToolDefSearchReplace,
  filegrepTool,
  filegrepToolDefHashline,
  filegrepToolDefSearchReplace,
} from "./skim";
import type { ProcessManager } from "../process-manager";
import type { Logger } from "../logger";
import type { EditMode } from "../config";
import { colorizeDiff, diffSummary } from "../diff";

export {
  readToolDefHashline,
  readToolDefSearchReplace,
  editToolDefHashline,
  editToolDefSearchReplace,
  writeToolDef,
  shellToolDef,
  shellStatusToolDef,
  skimToolDefHashline,
  skimToolDefSearchReplace,
  filegrepToolDefHashline,
  filegrepToolDefSearchReplace,
};
/** Backward-compatible aliases (hashline mode). */
export { readToolDefHashline as readToolDef, editToolDefHashline as editToolDef, skimToolDefHashline as skimToolDef, filegrepToolDefHashline as filegrepToolDef };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Tool for asking the user a list of questions interactively (plan mode only). */
export const askUserToolDef: ToolDef = {
  name: "ask_user",
  description:
    "Ask the user a list of clarifying questions. Each question is presented one at a time and the user answers interactively. Use this when you need information from the user before you can produce a solid plan.",
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

/** Options for {@link buildToolDefs}. */
export interface BuildToolDefsOptions {
  /** When true, include the `ask_user` tool (plan mode). Default false. */
  includeAskUserTool?: boolean;
}

export function buildToolDefs(editMode: EditMode, options?: BuildToolDefsOptions): ToolDef[] {
  const readDef = editMode === "searchReplace" ? readToolDefSearchReplace : readToolDefHashline;
  const editDef = editMode === "searchReplace" ? editToolDefSearchReplace : editToolDefHashline;
  const skimDef = editMode === "searchReplace" ? skimToolDefSearchReplace : skimToolDefHashline;
  const filegrepDef = editMode === "searchReplace" ? filegrepToolDefSearchReplace : filegrepToolDefHashline;
  const base: ToolDef[] = [
    readDef,
    editDef,
    writeToolDef,
    skimDef,
    filegrepDef,
    shellToolDef,
    shellStatusToolDef,
  ];
  if (options?.includeAskUserTool) {
    base.push(askUserToolDef);
  }
  return base;
}

/** Get tool definitions for hashline mode (default runtime set, no plan-only tools). */
export function getToolDefs(): ToolDef[] {
  return buildToolDefs("hashline");
}

// For OpenAI-format function schemas
export function getOpenAITools(editMode: EditMode = "hashline", options?: BuildToolDefsOptions) {
  return buildToolDefs(editMode, options).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// For Anthropic-format tool schemas
export function getAnthropicTools(editMode: EditMode = "hashline", options?: BuildToolDefsOptions) {
  return buildToolDefs(editMode, options).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));
}

// For Ollama-format tool schemas (same as OpenAI function calling format)
export function getOllamaTools(editMode: EditMode = "hashline", options?: BuildToolDefsOptions) {
  return buildToolDefs(editMode, options).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// For Gemini-format tool schemas (function declarations)
export function getGeminiTools(editMode: EditMode = "hashline", options?: BuildToolDefsOptions) {
  return [{
    functionDeclarations: buildToolDefs(editMode, options).map((t) => ({
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
  editMode: EditMode = "hashline",
): Promise<ToolCallResult> {
  const start = performance.now();
  let result: ToolCallResult;

  try {
    switch (name) {
      case "read": {
        const output = await readTool(args as any, cwd, editMode);
        result = {
          output,
          displaySummary: `read ${(args as any).path}`,
        };
        break;
      }
      case "edit": {
        const editResult: EditResult = await editTool(args as any, cwd, editMode);
        const summary = `edited ${(args as any).path} (${diffSummary(editResult.added, editResult.removed)})`;
        let output = editResult.message;
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
      case "skim": {
        const output = await skimTool(args as any, cwd, editMode);
        result = {
          output,
          displaySummary: `skim ${(args as any).path} [${(args as any).start_line}-${(args as any).end_line}]`,
        };
        break;
      }
      case "filegrep": {
        const output = await filegrepTool(args as any, cwd, editMode);
        result = {
          output,
          displaySummary: `filegrep ${(args as any).path} "${(args as any).pattern}"`,
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
