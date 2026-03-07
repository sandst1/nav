/**
 * Edit tool — hashline-anchored file editing.
 *
 * Flat schema: each tool call is one edit operation with top-level params.
 * Edits reference lines by LINE:HASH pairs from the read output.
 * Hashes are validated before mutation; stale refs are rejected
 * with updated hashes shown so the model can retry.
 */

import { join } from "node:path";
import {
  applyHashlineEdits,
  formatHashLineRanges,
  type HashlineEdit,
  HashMismatchError,
} from "../hashline";
import { generateDiff, diffAffectedNewLines, colorizeDiff, diffSummary } from "../diff";

interface EditArgs {
  path: string;
  anchor: string;
  end_anchor?: string;
  new_text: string;
  insert_after?: boolean;

  // Legacy: models may still send the old edits-array format
  edits?: unknown[];
  // Legacy: old nested format keys
  set_line?: unknown;
  replace_lines?: unknown;
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
 * Normalize legacy edit formats into the new flat HashlineEdit.
 *
 * Handles:
 * - Old nested: {set_line: {anchor, new_text}}
 * - Old nested: {replace_lines: {start_anchor, end_anchor, new_text}}
 * - Old nested: {insert_after: {anchor, text}}
 * - Old flat with type discriminator: {type: "set_line", anchor, new_text}
 */
function normalizeLegacyEdit(edit: unknown): HashlineEdit {
  const obj = edit as Record<string, unknown>;

  // Old nested format: {set_line: {anchor, new_text}}
  if ("set_line" in obj && typeof obj.set_line === "object" && obj.set_line) {
    const inner = obj.set_line as Record<string, unknown>;
    return { anchor: inner.anchor as string, new_text: inner.new_text as string };
  }

  // Old nested format: {replace_lines: {start_anchor, end_anchor, new_text}}
  if ("replace_lines" in obj && typeof obj.replace_lines === "object" && obj.replace_lines) {
    const inner = obj.replace_lines as Record<string, unknown>;
    return { anchor: inner.start_anchor as string, end_anchor: inner.end_anchor as string, new_text: inner.new_text as string };
  }

  // Old nested format: {insert_after: {anchor, text}}
  if ("insert_after" in obj && typeof obj.insert_after === "object" && obj.insert_after) {
    const inner = obj.insert_after as Record<string, unknown>;
    return { anchor: inner.anchor as string, new_text: inner.text as string, insert_after: true };
  }

  // Old flat format with type discriminator
  if ("type" in obj) {
    const type = obj.type as string;
    if (type === "set_line") {
      return { anchor: obj.anchor as string, new_text: obj.new_text as string };
    }
    if (type === "replace_lines") {
      return {
        anchor: (obj.start_anchor || obj.anchor) as string,
        end_anchor: obj.end_anchor as string,
        new_text: obj.new_text as string,
      };
    }
    if (type === "insert_after") {
      return {
        anchor: obj.anchor as string,
        new_text: (obj.text || obj.new_text) as string,
        insert_after: true,
      };
    }
  }

  // Already flat format or close enough — pass through
  return obj as unknown as HashlineEdit;
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

  // Build the edits array. New format: flat top-level params → single edit.
  // Legacy format: edits array or old nested keys.
  let edits: HashlineEdit[];

  if (args.anchor) {
    // New flat format — single edit from top-level params
    edits = [{
      anchor: args.anchor,
      end_anchor: args.end_anchor,
      new_text: args.new_text,
      insert_after: args.insert_after,
    }];
  } else if (args.edits && Array.isArray(args.edits) && args.edits.length > 0) {
    // Legacy edits array
    let rawEdits = args.edits;
    // Some models emit edits as a JSON string
    if (typeof rawEdits === "string") {
      try {
        rawEdits = JSON.parse(rawEdits as unknown as string);
      } catch {
        throw new Error("Failed to parse edits string as JSON");
      }
    }
    edits = (rawEdits as unknown[]).map(normalizeLegacyEdit);
  } else if (args.set_line || args.replace_lines) {
    // Legacy: old nested keys at top level
    edits = [normalizeLegacyEdit(args as unknown)];
  } else {
    throw new Error("Missing required parameter: anchor");
  }

  const oldContent = await file.text();

  try {
    const result = applyHashlineEdits(oldContent, edits);

    if (result.content === oldContent) {
      throw new Error(
        "No changes made — the edits produced identical content. Re-read the file to see current state.",
      );
    }

    // Write the file
    await Bun.write(target, result.content);

    // Generate diff
    const { diff, added, removed } = generateDiff(oldContent, result.content);

    // Generate updated hashlines for only the affected lines (+ context)
    const affectedLines = diffAffectedNewLines(diff, result.content.split("\n").length);
    const updatedHashlines = formatHashLineRanges(result.content, affectedLines);

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
  description: `Edit a file using hashline anchors from the read tool output. Each anchor is a "LINE:HASH" pair (e.g. "5:a3").

- Replace one line: anchor="5:a3", new_text="replacement"
- Replace a range: anchor="5:a3", end_anchor="12:f1", new_text="replacement"
- Insert after a line: anchor="5:a3", new_text="new lines", insert_after=true
- Delete lines: anchor="5:a3", new_text=""

Anchors come from the read tool output (the NUM:HH prefix on each line). All anchors reference the file state at the time of the last read.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "File path",
      },
      anchor: {
        type: "string" as const,
        description: 'Start line reference from read output, e.g. "5:a3"',
      },
      end_anchor: {
        type: "string" as const,
        description: 'End line reference for range edits, e.g. "12:f1". Omit for single-line edits.',
      },
      new_text: {
        type: "string" as const,
        description: 'Replacement text. Use "" to delete lines.',
      },
      insert_after: {
        type: "boolean" as const,
        description: "If true, insert new_text after the anchor line instead of replacing it.",
      },
    },
    required: ["path", "anchor", "new_text"] as const,
  },
};
