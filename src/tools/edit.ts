/**
 * Edit tool — hashline-anchored file editing.
 *
 * Edits reference lines by LINE:HASH pairs from the read output.
 * Hashes are validated before mutation; stale refs are rejected
 * with updated hashes shown so the model can retry.
 */

import { join } from "node:path";
import {
  applyHashlineEdits,
  type HashlineEdit,
  HashMismatchError,
} from "../hashline";
import { generateDiff, colorizeDiff, diffSummary } from "../diff";

interface EditArgs {
  path: string;
  edits: HashlineEdit[];
}

export interface EditResult {
  message: string;
  diff: string;
  added: number;
  removed: number;
}

export async function editTool(
  args: EditArgs,
  cwd: string,
): Promise<EditResult> {
  const target = args.path.startsWith("/")
    ? args.path
    : join(cwd, args.path);

  const file = Bun.file(target);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${args.path}`);
  }

  if (!args.edits || args.edits.length === 0) {
    throw new Error("No edits provided");
  }

  // Validate edit shapes
  for (let i = 0; i < args.edits.length; i++) {
    const edit = args.edits[i]! as unknown as Record<string, unknown>;
    if (!("set_line" in edit) && !("replace_lines" in edit) && !("insert_after" in edit)) {
      throw new Error(
        `edits[${i}] must contain one of: set_line, replace_lines, insert_after. Got: [${Object.keys(edit).join(", ")}]`,
      );
    }
  }

  const oldContent = await file.text();

  try {
    const result = applyHashlineEdits(oldContent, args.edits);

    if (result.content === oldContent) {
      throw new Error(
        "No changes made — the edits produced identical content. Re-read the file to see current state.",
      );
    }

    // Write the file
    await Bun.write(target, result.content);

    // Generate diff
    const { diff, added, removed } = generateDiff(oldContent, result.content);

    return {
      message: `Updated ${args.path} (${diffSummary(added, removed)})`,
      diff,
      added,
      removed,
    };
  } catch (e) {
    if (e instanceof HashMismatchError) {
      throw new Error(e.message);
    }
    throw e;
  }
}

export const editToolDef = {
  name: "edit" as const,
  description: `Edit a file using hashline anchors from read output. Each edit references lines by their number:hash pair (e.g. "53:0c").

Edit types:
- set_line: Replace one line. {set_line: {anchor: "53:a3", new_text: "replacement"}}
- replace_lines: Replace a range. {replace_lines: {start_anchor: "10:b2", end_anchor: "15:f1", new_text: "replacement"}}
- insert_after: Insert after a line. {insert_after: {anchor: "42:de", text: "new lines"}}

new_text: "" means delete. All refs use the original file state (before any edits in same call). Anchors come from the read tool output (the NUM:HH prefix on each line).`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "File path",
      },
      edits: {
        type: "array" as const,
        description: "Array of edit operations",
        items: {
          type: "object" as const,
        },
      },
    },
    required: ["path", "edits"] as const,
  },
};
