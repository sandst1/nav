/**
 * Hashline engine — line-addressable editing using content hashes.
 *
 * Each line is identified by `LINE:HASH` where HASH is a 2-char hex digest
 * of xxHash32 over whitespace-stripped content. This gives the model a
 * stable, verifiable anchor for edits without reproducing old content.
 *
 * Display format:  `LINE:HASH|content`
 * Reference format: `"LINE:HASH"` (e.g. `"5:a3"`)
 */

// --- Hash computation ---

const HASH_LEN = 2;
const HASH_MOD = 16 ** HASH_LEN; // 256
const DICT = Array.from({ length: HASH_MOD }, (_, i) =>
  i.toString(16).padStart(HASH_LEN, "0"),
);

/** Compute a 2-char hex hash for a line. Whitespace is stripped before hashing. */
export function computeLineHash(_lineNum: number, line: string): string {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  const stripped = line.replace(/\s+/g, "");
  return DICT[Bun.hash.xxHash32(stripped) % HASH_MOD]!;
}

/** Format file content with hashline prefixes for display. */
export function formatHashLines(content: string, startLine = 1): string {
  const lines = content.split("\n");
  return lines
    .map((line, i) => {
      const num = startLine + i;
      const hash = computeLineHash(num, line);
      return `${num}:${hash}|${line}`;
    })
    .join("\n");
}

// --- Reference parsing ---

/** Parse "LINE:HASH" into structured form. Tolerant of display-format suffixes. */
export function parseLineRef(ref: string): { line: number; hash: string } {
  // Strip display suffix: "5:ab|content" -> "5:ab"
  const cleaned = ref.replace(/\|.*$/, "").trim();
  const match = cleaned.match(/^(\d+):([0-9a-fA-F]{1,4})$/);
  if (!match) {
    throw new Error(
      `Invalid line reference "${ref}". Expected format "LINE:HASH" (e.g. "5:a3").`,
    );
  }
  const line = parseInt(match[1]!, 10);
  if (line < 1) throw new Error(`Line number must be >= 1, got ${line}`);
  return { line, hash: match[2]!.toLowerCase() };
}

// --- Validation ---

export interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

const MISMATCH_CONTEXT = 2;

export class HashMismatchError extends Error {
  constructor(
    public readonly mismatches: HashMismatch[],
    public readonly fileLines: string[],
  ) {
    super(HashMismatchError.formatMessage(mismatches, fileLines));
    this.name = "HashMismatchError";
  }

  static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
    const mismatchSet = new Set(mismatches.map((m) => m.line));
    const displayLines = new Set<number>();
    for (const m of mismatches) {
      const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
      const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
      for (let i = lo; i <= hi; i++) displayLines.add(i);
    }

    const sorted = [...displayLines].sort((a, b) => a - b);
    const lines: string[] = [
      `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE:HASH references below (>>> marks changed lines).`,
      "",
    ];

    let prev = -1;
    for (const num of sorted) {
      if (prev !== -1 && num > prev + 1) lines.push("  ...");
      prev = num;
      const content = fileLines[num - 1]!;
      const hash = computeLineHash(num, content);
      const prefix = `${num}:${hash}`;
      lines.push(mismatchSet.has(num) ? `>>> ${prefix}|${content}` : `    ${prefix}|${content}`);
    }
    return lines.join("\n");
  }
}

function validateLineRef(
  ref: { line: number; hash: string },
  fileLines: string[],
): HashMismatch | null {
  if (ref.line < 1 || ref.line > fileLines.length) {
    throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
  }
  const actual = computeLineHash(ref.line, fileLines[ref.line - 1]!);
  if (actual !== ref.hash.toLowerCase()) {
    return { line: ref.line, expected: ref.hash, actual };
  }
  return null;
}

// --- Edit types ---

export interface SetLineEdit {
  set_line: { anchor: string; new_text: string };
}
export interface ReplaceLinesEdit {
  replace_lines: { start_anchor: string; end_anchor: string; new_text: string };
}
export interface InsertAfterEdit {
  insert_after: { anchor: string; text: string };
}

export type HashlineEdit = SetLineEdit | ReplaceLinesEdit | InsertAfterEdit;

// --- Hashline prefix stripping ---

const HASHLINE_PREFIX_RE = /^\d+:[0-9a-fA-F]{1,4}\|/;

/** Strip hashline prefixes that models accidentally include in new_text. */
function stripHashlinePrefixes(lines: string[]): string[] {
  let count = 0;
  for (const l of lines) {
    if (l.length > 0 && HASHLINE_PREFIX_RE.test(l)) count++;
  }
  const nonEmpty = lines.filter((l) => l.length > 0).length;
  if (nonEmpty > 0 && count >= nonEmpty * 0.5) {
    return lines.map((l) => l.replace(HASHLINE_PREFIX_RE, ""));
  }
  return lines;
}

// --- Edit application ---

interface ParsedEdit {
  kind: "set" | "range" | "insert";
  startLine: number;
  endLine: number; // same as startLine for set/insert
  startRef: { line: number; hash: string };
  endRef?: { line: number; hash: string };
  newLines: string[];
}

function parseEdit(edit: HashlineEdit): ParsedEdit {
  if ("set_line" in edit) {
    const ref = parseLineRef(edit.set_line.anchor);
    const newLines =
      edit.set_line.new_text === "" ? [] : edit.set_line.new_text.split("\n");
    return {
      kind: "set",
      startLine: ref.line,
      endLine: ref.line,
      startRef: ref,
      newLines: stripHashlinePrefixes(newLines),
    };
  }
  if ("replace_lines" in edit) {
    const start = parseLineRef(edit.replace_lines.start_anchor);
    const end = parseLineRef(edit.replace_lines.end_anchor);
    if (start.line > end.line) {
      throw new Error(
        `Range start ${start.line} must be <= end ${end.line}`,
      );
    }
    const newLines =
      edit.replace_lines.new_text === ""
        ? []
        : edit.replace_lines.new_text.split("\n");
    return {
      kind: "range",
      startLine: start.line,
      endLine: end.line,
      startRef: start,
      endRef: end,
      newLines: stripHashlinePrefixes(newLines),
    };
  }
  // insert_after
  const ref = parseLineRef(edit.insert_after.anchor);
  if (!edit.insert_after.text) {
    throw new Error("insert_after requires non-empty text");
  }
  const newLines = edit.insert_after.text.split("\n");
  return {
    kind: "insert",
    startLine: ref.line,
    endLine: ref.line,
    startRef: ref,
    newLines: stripHashlinePrefixes(newLines),
  };
}

/**
 * Apply hashline edits to file content.
 *
 * All edits reference line numbers/hashes from the original file state.
 * They are validated, sorted bottom-up, and applied so earlier splices
 * don't invalidate later line numbers.
 *
 * Returns the modified content and a diff summary.
 */
export function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[],
): { content: string; linesAdded: number; linesRemoved: number } {
  if (edits.length === 0) return { content, linesAdded: 0, linesRemoved: 0 };

  const fileLines = content.split("\n");
  const parsed = edits.map(parseEdit);

  // Validate all refs before mutating
  const mismatches: HashMismatch[] = [];
  for (const p of parsed) {
    const m1 = validateLineRef(p.startRef, fileLines);
    if (m1) mismatches.push(m1);
    if (p.endRef) {
      const m2 = validateLineRef(p.endRef, fileLines);
      if (m2) mismatches.push(m2);
    }
  }
  if (mismatches.length > 0) {
    throw new HashMismatchError(mismatches, fileLines);
  }

  // Sort bottom-up (highest line first) for stable splicing
  // For same line: inserts after replacements
  parsed.sort((a, b) => {
    if (b.endLine !== a.endLine) return b.endLine - a.endLine;
    // inserts (kind="insert") should come after replacements at same line
    const prec = (k: string) => (k === "insert" ? 1 : 0);
    return prec(a.kind) - prec(b.kind);
  });

  let linesAdded = 0;
  let linesRemoved = 0;

  for (const p of parsed) {
    switch (p.kind) {
      case "set": {
        const removed = 1;
        fileLines.splice(p.startLine - 1, removed, ...p.newLines);
        linesRemoved += removed;
        linesAdded += p.newLines.length;
        break;
      }
      case "range": {
        const removed = p.endLine - p.startLine + 1;
        fileLines.splice(p.startLine - 1, removed, ...p.newLines);
        linesRemoved += removed;
        linesAdded += p.newLines.length;
        break;
      }
      case "insert": {
        fileLines.splice(p.startLine, 0, ...p.newLines);
        linesAdded += p.newLines.length;
        break;
      }
    }
  }

  return { content: fileLines.join("\n"), linesAdded, linesRemoved };
}
