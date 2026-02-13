/**
 * Read tool — reads files and directories with hashline-prefixed output.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { formatHashLines } from "../hashline";

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

  // Directory listing
  if (st.isDirectory()) {
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
        .slice(0, 200);
      return lines.join("\n");
    } catch (e) {
      return `Error reading directory: ${e}`;
    }
  }

  // File reading
  if (st.size > MAX_BYTES) {
    // Still try to read a portion
  }

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
    let output = formatHashLines(selectedContent, startLine);

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

export const readToolDef = {
  name: "read" as const,
  description:
    "Read a file or directory. Files are shown with hashline prefixes (LINE:HASH|content). Use offset/limit for large files.",
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "File or directory path (relative or absolute)",
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
