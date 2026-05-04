/**
 * Deterministic JSON extraction from assistant text.
 *
 * Priority:
 * 1) Last parseable fenced block (```json ... ``` or ``` ... ```)
 *    (last wins so that refined/updated blocks supersede earlier drafts)
 * 2) Entire trimmed message as JSON
 * 3) First parseable balanced JSON object/array substring
 *
 * Avoid broad regex matching; use balanced scanning instead for fallback.
 */

const FENCED_BLOCK_RE = /```[^\n]*\n?([\s\S]*?)```/g;

function parseFirstBalancedJsonSubstring(text: string): unknown | null {
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") starts.push(i);
  }

  for (const start of starts) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") inString = false;
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === open) depth++;
      else if (ch === close) depth--;

      if (depth === 0) {
        const candidate = text.slice(start, i + 1).trim();
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

export function parseJsonFromAssistantText(text: string): unknown | null {
  let match: RegExpExecArray | null;
  let lastParsed: unknown | null = null;
  while ((match = FENCED_BLOCK_RE.exec(text)) !== null) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    try {
      lastParsed = JSON.parse(candidate);
    } catch {
      // Keep scanning fenced blocks
    }
  }
  if (lastParsed !== null) return lastParsed;

  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return parseFirstBalancedJsonSubstring(trimmed);
  }
}

