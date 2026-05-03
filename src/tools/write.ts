/**
 * Write tool — create or overwrite files.
 */

import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

interface WriteArgs {
  path: string;
  content: string;
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

  // Ensure parent directory exists
  mkdirSync(dirname(target), { recursive: true });

  // If the LLM passed an object/array instead of a string, stringify it
  const content =
    typeof args.content === "string"
      ? args.content
      : JSON.stringify(args.content, null, 2);

  await Bun.write(target, content);
  const lines = content.split("\n").length;
  return `Wrote ${args.path} (${lines} lines, ${content.length} bytes)`;
}

export const writeToolDef = {
  name: "write" as const,
  description: "Create/overwrite file; parent dirs auto-created.",
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
    },
    required: ["path", "content"] as const,
  },
};
