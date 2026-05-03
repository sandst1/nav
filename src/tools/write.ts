/**
 * Write tool — create or overwrite files.
 */

import { join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

interface WriteArgs {
  path: string;
  content: string;
  /** If true, allow overwriting an existing file. Default false. */
  overwrite?: boolean;
}

export async function writeTool(
  args: WriteArgs,
  cwd: string,
): Promise<string> {
  if (!args.path) {
    throw new Error("Missing required parameter: path");
  }

  const target = args.path.startsWith("/")
    ? args.path
    : join(cwd, args.path);

  const exists = existsSync(target);
  if (exists && !args.overwrite) {
    throw new Error(
      `Refusing to overwrite existing file: ${args.path}. ` +
      `Use edit for existing files, or call write with overwrite=true to replace it.`,
    );
  }

  // Ensure parent directory exists
  mkdirSync(dirname(target), { recursive: true });

  // If the LLM passed an object/array instead of a string, stringify it
  const content =
    typeof args.content === "string"
      ? args.content
      : JSON.stringify(args.content, null, 2);

  await Bun.write(target, content);
  const lines = content.split("\n").length;
  const verb = exists ? "Overwrote" : "Wrote";
  return `${verb} ${args.path} (${lines} lines, ${content.length} bytes)`;
}

export const writeToolDef = {
  name: "write" as const,
  description:
    "Create file (safe by default). Existing files require overwrite=true; parent dirs auto-created.",
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "File path (relative or absolute)",
      },
      content: {
        type: "string" as const,
        description: "File content to write",
      },
      overwrite: {
        type: "boolean" as const,
        description: "Allow replacing an existing file. Default false.",
      },
    },
    required: ["path", "content"] as const,
  },
};
