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
  formatHashLines,
  type HashlineEdit,
  HashMismatchError,
} from "../hashline";
import { generateDiff, colorizeDiff, diffSummary } from "../diff";

interface EditArgs {
  path: string;
  edits: HashlineEdit[];
  // Flat top-level format some models emit instead of using the edits array
  edit_type?: string;
  anchor?: string;
  start_anchor?: string;
  end_anchor?: string;
  new_text?: string;
  text?: string;
}

export interface EditResult {
  message: string;
  diff: string;
  added: number;
  removed: number;
  /** Updated file content with hashline prefixes for the model. */
  updatedHashlines: string;
}

/**
 * Normalize a flat-format edit into the nested format the engine expects.
 *
 * Models sometimes produce:
 *   {type: "replace_lines", start_anchor: "1:96", end_anchor: "53:0c", new_text: "..."}
 * instead of:
 *   {replace_lines: {start_anchor: "1:96", end_anchor: "53:0c", new_text: "..."}}
 *
 * This function accepts both and converts the flat form into the nested one.
 */
function normalizeEdit(edit: unknown): HashlineEdit {
  const obj = edit as Record<string, unknown>;

  // Already in nested format — pass through
  if ("set_line" in obj || "replace_lines" in obj || "insert_after" in obj) {
    return obj as unknown as HashlineEdit;
  }

  // Flat format with a "type" discriminator
  const type = obj.type as string | undefined;
  if (!type) {
    return obj as unknown as HashlineEdit; // let validation catch it
  }

  const { type: _, ...rest } = obj;

  switch (type) {
    case "set_line":
      return { set_line: rest } as unknown as HashlineEdit;
    case "replace_lines":
      return { replace_lines: rest } as unknown as HashlineEdit;
    case "insert_after":
      return { insert_after: rest } as unknown as HashlineEdit;
    default:
      return obj as unknown as HashlineEdit; // let validation catch unknown type
  }
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

  // Some models emit the edit operation as flat top-level args with an edit_type
  // discriminator instead of wrapping it in the edits array. Detect and fix this.
  if ((!args.edits || args.edits.length === 0) && args.edit_type) {
    const { edit_type, anchor, start_anchor, end_anchor, new_text, text } = args;
    const rest: Record<string, unknown> = {};
    if (anchor !== undefined) rest.anchor = anchor;
    if (start_anchor !== undefined) rest.start_anchor = start_anchor;
    if (end_anchor !== undefined) rest.end_anchor = end_anchor;
    if (new_text !== undefined) rest.new_text = new_text;
    if (text !== undefined) rest.text = text;
    args.edits = [{ [edit_type]: rest }] as unknown as HashlineEdit[];
  }

  if (!args.edits || args.edits.length === 0) {
    throw new Error("No edits provided");
  }

  // Normalize flat-format edits (e.g. {type: "replace_lines", ...}) into nested format
  args.edits = args.edits.map((edit) => normalizeEdit(edit));

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

    // Generate updated hashlines so the model has fresh hashes for subsequent edits
    const updatedHashlines = formatHashLines(result.content);

    return {
      message: `Updated ${args.path} (${diffSummary(added, removed)})`,
      diff,
      added,
      removed,
      updatedHashlines,
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
