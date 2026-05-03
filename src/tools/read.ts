/**
 * Read tool — reads file contents with hashline-prefixed output.
 *
 * For directory exploration, the agent should use shell commands (ls, find, tree, etc.).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { formatHashLines } from "../hashline";
import type { EditMode } from "../config";

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export async function readTool(
  args: ReadArgs,
  cwd: string,
  editMode: EditMode = "hashline",
): Promise<string> {
  const target = args.path.startsWith("/")
    ? args.path
    : join(cwd, args.path);

  let st;
  try {
    st = await stat(target);
  } catch {
    return `Error: file not found: ${args.path}`;
  }

  // Reject directories — use shell for exploration
  if (st.isDirectory()) {
    return `Error: "${args.path}" is a directory. Use shell commands to explore directories:\n  ls -la ${args.path}\n  find ${args.path} -type f\n  tree ${args.path}`;
  }

  // File reading
  try {
    const file = Bun.file(target);
    const content = await file.text();
    const allLines = content.split("\n");
    const startLine = args.offset ? Math.max(1, args.offset) : 1;
    const startIdx = startLine - 1;

    if (startIdx >= allLines.length) {
      return `Error: offset ${startLine} is beyond end of file (${allLines.length} lines)`;
    }

    const maxLines = args.limit ?? MAX_LINES;
    const selectedLines = allLines.slice(startIdx, startIdx + maxLines);
    const selectedContent = selectedLines.join("\n");

    // Check byte limit
    const bytes = Buffer.byteLength(selectedContent, "utf-8");
    let output =
      editMode === "searchReplace"
        ? selectedContent
        : formatHashLines(selectedContent, startLine);

    const totalLines = allLines.length;
    const endLine = startIdx + selectedLines.length;

    if (endLine < totalLines) {
      const remaining = totalLines - endLine;
      output += `\n\n[${remaining} more lines. Use offset=${endLine + 1} to continue]`;
    }

    if (bytes > MAX_BYTES) {
      output += `\n[Output truncated at ${MAX_BYTES} bytes]`;
    }

    return output;
  } catch (e) {
    return `Error reading file: ${e}`;
  }
}

export const readToolDefHashline = {
  name: "read" as const,
  description:
    "Read file → hashlines LINE:HASH|text. offset/limit for large files. Not for dirs (use shell: ls/find/tree).",
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "Path to the file (relative or absolute)",
      },
      offset: {
        type: "number" as const,
        description: "Line number to start from (1-indexed)",
      },
      limit: {
        type: "number" as const,
        description: "Max lines to read",
      },
    },
    required: ["path"] as const,
  },
};

export const readToolDefSearchReplace = {
  ...readToolDefHashline,
  description:
    "Read file → plain text. offset/limit for large files. Not for dirs (shell: ls/find/tree).",
};

export const readToolDef = readToolDefHashline;
