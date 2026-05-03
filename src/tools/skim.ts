/**
 * Skim & filegrep tools — lightweight file inspection with hashline output.
 *
 * skim: read a specific line range
 * filegrep: case-insensitive substring search within a file with context lines
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { formatHashLines, formatHashLineRanges, formatPlainLineRanges } from "../hashline";
import type { EditMode } from "../config";

const MAX_SKIM_LINES = 500;
const MAX_GREP_MATCHES = 100;

class FileReadError {
  constructor(public readonly message: string) {}
}

async function readFileLines(
  path: string,
  cwd: string,
): Promise<string[] | FileReadError> {
  const target = path.startsWith("/") ? path : join(cwd, path);

  let st;
  try {
    st = await stat(target);
  } catch {
    return new FileReadError(`Error: file not found: ${path}`);
  }

  if (st.isDirectory()) {
    return new FileReadError(`Error: "${path}" is a directory, not a file.`);
  }

  try {
    const file = Bun.file(target);
    const content = await file.text();
    return content.split("\n");
  } catch (e) {
    return new FileReadError(`Error reading file: ${e}`);
  }
}

// --- skim ---

interface SkimArgs {
  path: string;
  start_line: number;
  end_line: number;
}

export async function skimTool(
  args: SkimArgs,
  cwd: string,
  editMode: EditMode = "hashline",
): Promise<string> {
  const result = await readFileLines(args.path, cwd);
  if (result instanceof FileReadError) return result.message;

  const lines = result;
  const totalLines = lines.length;
  const startLine = Math.max(1, args.start_line);

  if (startLine > totalLines) {
    return `Error: start_line ${startLine} is beyond end of file (${totalLines} lines)`;
  }

  let endLine = Math.min(args.end_line, totalLines);
  if (endLine - startLine + 1 > MAX_SKIM_LINES) {
    endLine = startLine + MAX_SKIM_LINES - 1;
  }

  const selected = lines.slice(startLine - 1, endLine);
  let output = `[lines ${startLine}-${endLine} of ${totalLines} total]\n`;
  output +=
    editMode === "searchReplace"
      ? selected.join("\n")
      : formatHashLines(selected.join("\n"), startLine);
  return output;
}

export const skimToolDefHashline = {
  name: "skim" as const,
  description:
    "Line range from file → hashlines. Cheaper than full read when region is known.",
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "Path to the file (relative or absolute)",
      },
      start_line: {
        type: "number" as const,
        description: "First line to read (1-indexed, inclusive)",
      },
      end_line: {
        type: "number" as const,
        description: "Last line to read (1-indexed, inclusive)",
      },
    },
    required: ["path", "start_line", "end_line"] as const,
  },
};

export const skimToolDefSearchReplace = {
  ...skimToolDefHashline,
  description: "Line range from file → plain text.",
};

export const skimToolDef = skimToolDefHashline;

// --- filegrep ---

interface FilegrepArgs {
  path: string;
  pattern: string;
  linesBefore?: number;
  linesAfter?: number;
}

export async function filegrepTool(
  args: FilegrepArgs,
  cwd: string,
  editMode: EditMode = "hashline",
): Promise<string> {
  const result = await readFileLines(args.path, cwd);
  if (result instanceof FileReadError) return result.message;

  const lines = result;
  const totalLines = lines.length;
  const needle = args.pattern.toLowerCase();
  const before = args.linesBefore ?? 2;
  const after = args.linesAfter ?? 2;

  const matchLineNums: number[] = [];
  for (let i = 0; i < totalLines; i++) {
    if (lines[i]!.toLowerCase().includes(needle)) {
      matchLineNums.push(i + 1);
      if (matchLineNums.length >= MAX_GREP_MATCHES) break;
    }
  }

  if (matchLineNums.length === 0) {
    return `No matches for "${args.pattern}" in ${args.path} (${totalLines} lines)`;
  }

  const lineSet = new Set<number>();
  for (const num of matchLineNums) {
    const lo = Math.max(1, num - before);
    const hi = Math.min(totalLines, num + after);
    for (let i = lo; i <= hi; i++) lineSet.add(i);
  }

  const truncated = matchLineNums.length >= MAX_GREP_MATCHES;
  let header = `[${matchLineNums.length}${truncated ? "+" : ""} match${matchLineNums.length === 1 ? "" : "es"} in ${totalLines} lines]`;
  if (truncated) header += ` (showing first ${MAX_GREP_MATCHES})`;

  const content = lines.join("\n");
  const body =
    editMode === "searchReplace"
      ? formatPlainLineRanges(content, lineSet)
      : formatHashLineRanges(content, lineSet);
  return `${header}\n${body}`;
}

export const filegrepToolDefHashline = {
  name: "filegrep" as const,
  description:
    "Case-insensitive substring in one file; context lines; hashline output. Quick local grep.",
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "Path to the file (relative or absolute)",
      },
      pattern: {
        type: "string" as const,
        description: "Substring to search for (case-insensitive)",
      },
      linesBefore: {
        type: "number" as const,
        description: "Context lines before each match (default: 2)",
      },
      linesAfter: {
        type: "number" as const,
        description: "Context lines after each match (default: 2)",
      },
    },
    required: ["path", "pattern"] as const,
  },
};

export const filegrepToolDefSearchReplace = {
  ...filegrepToolDefHashline,
  description:
    "Case-insensitive substring in one file; context as plain text (gaps as ...).",
};

export const filegrepToolDef = filegrepToolDefHashline;
