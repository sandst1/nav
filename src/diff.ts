/**
 * Minimal unified diff generation using Myers algorithm.
 * Zero dependencies — produces standard unified diff output.
 */

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Compute shortest edit script (Myers diff) between two arrays of strings.
 * Returns array of operations: "=" (keep), "-" (delete), "+" (insert).
 */
function myersDiff(
  a: string[],
  b: string[],
): Array<{ op: "=" | "-" | "+"; line: string }> {
  const n = a.length;
  const m = b.length;
  const max = n + m;

  // For very large files, fall back to a simpler line-by-line comparison
  if (max > 20000) {
    return simpleDiff(a, b);
  }

  const v = new Map<number, number>();
  const trace: Map<number, number>[] = [];
  v.set(0, 0);

  outer: for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        trace.push(new Map(v));
        break outer;
      }
    }
    trace.push(new Map(v));
  }

  // Backtrack to find the actual edit script
  const ops: Array<{ op: "=" | "-" | "+"; line: string }> = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!;
    const k = x - y;
    let prevK: number;

    if (k === -d || (k !== d && (prev.get(k - 1) ?? 0) < (prev.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = prev.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // Diagonal (equal lines)
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: "=", line: a[x]! });
    }

    if (x > prevX) {
      x--;
      ops.push({ op: "-", line: a[x]! });
    } else if (y > prevY) {
      y--;
      ops.push({ op: "+", line: b[y]! });
    }
  }

  // Handle remaining diagonal at the start
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ op: "=", line: a[x]! });
  }
  while (x > 0) {
    x--;
    ops.push({ op: "-", line: a[x]! });
  }
  while (y > 0) {
    y--;
    ops.push({ op: "+", line: b[y]! });
  }

  ops.reverse();
  return ops;
}

/** Simple fallback diff for very large files. */
function simpleDiff(
  a: string[],
  b: string[],
): Array<{ op: "=" | "-" | "+"; line: string }> {
  const ops: Array<{ op: "=" | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: "=", line: a[i]! });
      i++;
      j++;
    } else {
      // Find next matching line
      let foundA = -1;
      let foundB = -1;
      for (let look = 1; look < 10; look++) {
        if (foundB === -1 && j + look < b.length && a[i] === b[j + look]) foundB = look;
        if (foundA === -1 && i + look < a.length && a[i + look] === b[j]) foundA = look;
        if (foundA !== -1 || foundB !== -1) break;
      }
      if (foundB !== -1 && (foundA === -1 || foundB <= foundA)) {
        for (let k = 0; k < foundB; k++) ops.push({ op: "+", line: b[j + k]! });
        j += foundB;
      } else if (foundA !== -1) {
        for (let k = 0; k < foundA; k++) ops.push({ op: "-", line: a[i + k]! });
        i += foundA;
      } else {
        ops.push({ op: "-", line: a[i]! });
        ops.push({ op: "+", line: b[j]! });
        i++;
        j++;
      }
    }
  }
  while (i < a.length) ops.push({ op: "-", line: a[i++]! });
  while (j < b.length) ops.push({ op: "+", line: b[j++]! });
  return ops;
}

/**
 * Generate unified diff string between two contents.
 * Returns the diff text and summary stats.
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  contextLines = 3,
): { diff: string; added: number; removed: number } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const ops = myersDiff(oldLines, newLines);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.op === "+") added++;
    if (op.op === "-") removed++;
  }

  // Build hunks with context
  const hunks: DiffHunk[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  // Find change regions and add context
  const changes: Array<{ idx: number; op: "+" | "-" }> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.op !== "=") changes.push({ idx: i, op: ops[i]!.op as "+" | "-" });
  }

  if (changes.length === 0) {
    return { diff: "", added: 0, removed: 0 };
  }

  // Group changes into hunks (merge if within 2*contextLines of each other)
  const groups: Array<{ start: number; end: number }> = [];
  let currentGroup = { start: changes[0]!.idx, end: changes[0]!.idx };

  for (let i = 1; i < changes.length; i++) {
    if (changes[i]!.idx - currentGroup.end <= contextLines * 2) {
      currentGroup.end = changes[i]!.idx;
    } else {
      groups.push({ ...currentGroup });
      currentGroup = { start: changes[i]!.idx, end: changes[i]!.idx };
    }
  }
  groups.push(currentGroup);

  // Build each hunk
  for (const group of groups) {
    const hunkStart = Math.max(0, group.start - contextLines);
    const hunkEnd = Math.min(ops.length - 1, group.end + contextLines);

    const hunkLines: string[] = [];
    let hOld = 0;
    let hNew = 0;
    let oldStart = 0;
    let newStart = 0;

    // Calculate starting positions
    let oIdx = 0;
    let nIdx = 0;
    for (let i = 0; i < hunkStart; i++) {
      if (ops[i]!.op === "=" || ops[i]!.op === "-") oIdx++;
      if (ops[i]!.op === "=" || ops[i]!.op === "+") nIdx++;
    }
    oldStart = oIdx + 1;
    newStart = nIdx + 1;

    for (let i = hunkStart; i <= hunkEnd; i++) {
      const op = ops[i]!;
      if (op.op === "=") {
        hunkLines.push(` ${op.line}`);
        hOld++;
        hNew++;
      } else if (op.op === "-") {
        hunkLines.push(`-${op.line}`);
        hOld++;
      } else {
        hunkLines.push(`+${op.line}`);
        hNew++;
      }
    }

    hunks.push({
      oldStart,
      oldCount: hOld,
      newStart,
      newCount: hNew,
      lines: hunkLines,
    });
  }

  // Format output
  const output: string[] = [];
  for (const hunk of hunks) {
    output.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    output.push(...hunk.lines);
  }

  return { diff: output.join("\n"), added, removed };
}

/**
 * Extract the set of new-file line numbers touched by a unified diff,
 * expanded by `context` lines in each direction.
 */
export function diffAffectedNewLines(diff: string, totalLines: number, context = 2): Set<number> {
  const lines = new Set<number>();
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  let newIdx = 0;

  for (const line of diff.split("\n")) {
    const m = hunkRe.exec(line);
    if (m) {
      newIdx = parseInt(m[1]!, 10);
      continue;
    }
    if (newIdx === 0) continue; // before first hunk

    if (line.startsWith("+")) {
      lines.add(newIdx);
      newIdx++;
    } else if (line.startsWith("-")) {
      // deleted line — doesn't advance new index
    } else {
      // context line (" ") or other
      newIdx++;
    }
  }

  // Expand by context
  const expanded = new Set<number>();
  for (const n of lines) {
    for (let i = Math.max(1, n - context); i <= Math.min(totalLines, n + context); i++) {
      expanded.add(i);
    }
  }
  return expanded;
}

// --- ANSI coloring for TUI ---

import { theme, RESET } from "./theme";

/** Colorize a unified diff string for terminal display. */
export function colorizeDiff(diff: string): string {
  if (!diff) return "";
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) return `${theme.diffHunk}${line}${RESET}`;
      if (line.startsWith("+")) return `${theme.diffAdd}${line}${RESET}`;
      if (line.startsWith("-")) return `${theme.diffRemove}${line}${RESET}`;
      return `${theme.dim}${line}${RESET}`;
    })
    .join("\n");
}

/** Generate a short summary like "+3, -2". */
export function diffSummary(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${theme.diffAdd}+${added}${RESET}`);
  if (removed > 0) parts.push(`${theme.diffRemove}-${removed}${RESET}`);
  if (parts.length === 0) return "no changes";
  return parts.join(", ");
}
