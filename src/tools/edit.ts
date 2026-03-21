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
import { generateDiff, diffAffectedNewLines, diffSummary } from "../diff";
import type { EditMode } from "../config";

/** Count non-overlapping occurrences of a literal substring. */
export function countLiteralOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const i = haystack.indexOf(needle, pos);
    if (i === -1) break;
    count++;
    pos = i + needle.length;
  }
  return count;
}

/**
 * Replace one or all occurrences of `oldString` with `newString`.
 * @throws Error if oldString is empty, not found, or ambiguous when replaceAll is false.
 */
export function applySearchReplaceContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString === "") {
    throw new Error(
      "old_string cannot be empty — use the write tool for new files, or include the exact text to replace",
    );
  }
  const n = countLiteralOccurrences(content, oldString);
  if (n === 0) {
    throw new Error(
      "old_string not found in file — re-read the file and copy the exact text to replace",
    );
  }
  if (!replaceAll && n > 1) {
    throw new Error(
      `old_string matched ${n} times; include more surrounding context so the match is unique, or set replace_all to true`,
    );
  }
  if (replaceAll) {
    return content.split(oldString).join(newString);
  }
  return content.replace(oldString, newString);
}

interface SearchReplaceEditArgs {
  path: string;
  old_string: string;
  new_string?: string;
  replace_all?: boolean;
}

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
  args: EditArgs | SearchReplaceEditArgs,
  cwd: string,
  editMode: EditMode = "hashline",
): Promise<EditResult> {
  if (!args.path) {
    throw new Error("Missing required parameter: path");
  }

  const target = args.path.startsWith("/")
    ? args.path
    : join(cwd, args.path);

  const file = Bun.file(target);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${args.path}`);
  }

  if (editMode === "searchReplace") {
    const sr = args as SearchReplaceEditArgs;
    if (sr.old_string === undefined) {
      throw new Error("Missing required parameter: old_string");
    }
    const oldStr = sr.old_string;
    const newStr = sr.new_string ?? "";
    const replaceAll = !!sr.replace_all;
    const oldContent = await file.text();
    const newContent = applySearchReplaceContent(oldContent, oldStr, newStr, replaceAll);
    if (newContent === oldContent) {
      throw new Error(
        "No changes made — new_string is identical to the matched text. Re-read the file to see current state.",
      );
    }
    await Bun.write(target, newContent);
    const { diff, added, removed } = generateDiff(oldContent, newContent);
    return {
      message: `Updated ${args.path} (${diffSummary(added, removed)})`,
      diff,
      added,
      removed,
      updatedHashlines: "",
    };
  }

  const hashArgs = args as EditArgs;

  // Build the edits array. New format: flat top-level params → single edit.
  // Legacy format: edits array or old nested keys.
  let edits: HashlineEdit[];

  if (hashArgs.anchor) {
    // New flat format — single edit from top-level params
    edits = [{
      anchor: hashArgs.anchor,
      end_anchor: hashArgs.end_anchor,
      new_text: hashArgs.new_text,
      insert_after: hashArgs.insert_after,
    }];
  } else if (hashArgs.edits && Array.isArray(hashArgs.edits) && hashArgs.edits.length > 0) {
    // Legacy edits array
    let rawEdits = hashArgs.edits;
    // Some models emit edits as a JSON string
    if (typeof rawEdits === "string") {
      try {
        rawEdits = JSON.parse(rawEdits as unknown as string);
      } catch {
        throw new Error("Failed to parse edits string as JSON");
      }
    }
    edits = (rawEdits as unknown[]).map(normalizeLegacyEdit);
  } else if (hashArgs.set_line || hashArgs.replace_lines) {
    // Legacy: old nested keys at top level
    edits = [normalizeLegacyEdit(hashArgs as unknown)];
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
      message: `Updated ${hashArgs.path} (${diffSummary(added, removed)})`,
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

export const editToolDefHashline = {
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

export const editToolDefSearchReplace = {
  name: "edit" as const,
  description: `Edit a file by replacing an exact literal substring. Read the file first and copy old_string from the current contents — including whitespace and newlines.

- Single replacement (default): old_string must appear exactly once unless replace_all is true.
- replace_all true: replace every occurrence of old_string.
- new_string may be empty to delete the matched text.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "File path",
      },
      old_string: {
        type: "string" as const,
        description: "Exact text to find in the file (from a recent read). Must be non-empty.",
      },
      new_string: {
        type: "string" as const,
        description: "Replacement text. Omit or use \"\" to delete old_string.",
      },
      replace_all: {
        type: "boolean" as const,
        description: "If true, replace every occurrence of old_string. If false, old_string must match exactly once.",
      },
    },
    required: ["path", "old_string"] as const,
  },
};

export const editToolDef = editToolDefHashline;
