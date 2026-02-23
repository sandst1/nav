/**
 * Tests for @-mention expansion.
 *
 * Uses real temp files on disk — no mocking needed since the implementation
 * uses Bun.file() / statSync directly.
 */

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expandAtMentions,
  hasAtMentions,
  parseAtMentions,
  expandOneMention,
  AT_MENTION_RE,
  type AtMention,
} from "../at-mention";

// ── Fixtures ─────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `nav-at-mention-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "hello.ts"), 'export const greeting = "hello";\n');
  writeFileSync(join(testDir, "multi.ts"), "line one\nline two\nline three\n");
  mkdirSync(join(testDir, "src"), { recursive: true });
  writeFileSync(join(testDir, "src", "util.ts"), "export function util() {}\n");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function mention(raw: string, resolvedPath: string, displayPath: string): AtMention {
  return { raw, resolvedPath, displayPath };
}

// ── AT_MENTION_RE ────────────────────────────────────────────────────

describe("AT_MENTION_RE", () => {
  test("matches simple @path", () => {
    AT_MENTION_RE.lastIndex = 0;
    const m = AT_MENTION_RE.exec("@foo.ts");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("foo.ts");
  });

  test("matches @path/nested/file.ts", () => {
    AT_MENTION_RE.lastIndex = 0;
    const m = AT_MENTION_RE.exec("@src/util.ts");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("src/util.ts");
  });

  test("does not match @ followed by space", () => {
    AT_MENTION_RE.lastIndex = 0;
    const m = AT_MENTION_RE.exec("@ foo");
    expect(m).toBeNull();
  });

  test("finds multiple mentions", () => {
    AT_MENTION_RE.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    const input = "see @a.ts and @b.ts";
    while ((m = AT_MENTION_RE.exec(input)) !== null) {
      matches.push(m[1]!);
    }
    expect(matches).toEqual(["a.ts", "b.ts"]);
  });
});

// ── hasAtMentions ────────────────────────────────────────────────────

describe("hasAtMentions", () => {
  test("returns true when prompt contains @path", () => {
    expect(hasAtMentions("look at @foo.ts")).toBe(true);
  });

  test("returns false when prompt has no @path", () => {
    expect(hasAtMentions("no mentions here")).toBe(false);
  });

  test("returns false for bare @ without path", () => {
    expect(hasAtMentions("email me @ home")).toBe(false);
  });
});

// ── parseAtMentions ──────────────────────────────────────────────────

describe("parseAtMentions", () => {
  test("parses single mention", () => {
    const result = parseAtMentions("check @hello.ts please", testDir);
    expect(result.length).toBe(1);
    expect(result[0]!.raw).toBe("@hello.ts");
    expect(result[0]!.displayPath).toBe("hello.ts");
  });

  test("parses multiple mentions", () => {
    const result = parseAtMentions("@hello.ts and @src/util.ts", testDir);
    expect(result.length).toBe(2);
    expect(result[0]!.displayPath).toBe("hello.ts");
    expect(result[1]!.displayPath).toBe("src/util.ts");
  });

  test("resolves absolute paths", () => {
    const abs = join(testDir, "hello.ts");
    const result = parseAtMentions(`@${abs}`, testDir);
    expect(result.length).toBe(1);
    expect(result[0]!.resolvedPath).toBe(abs);
  });
});

// ── expandOneMention ─────────────────────────────────────────────────

describe("expandOneMention", () => {
  test("expands existing file with hashline content", async () => {
    const resolvedPath = join(testDir, "hello.ts");
    const m = mention("@hello.ts", resolvedPath, "hello.ts");
    const result = await expandOneMention(m);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("1:");
      expect(result.content).toContain("greeting");
    }
  });

  test("returns error for nonexistent file", async () => {
    const resolvedPath = join(testDir, "missing.ts");
    const m = mention("@missing.ts", resolvedPath, "missing.ts");
    const result = await expandOneMention(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  test("returns error for directory", async () => {
    const resolvedPath = join(testDir, "src");
    const m = mention("@src", resolvedPath, "src");
    const result = await expandOneMention(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toMatch(/not a file|directory/);
    }
  });
});

// ── expandAtMentions ─────────────────────────────────────────────────

describe("expandAtMentions", () => {
  test("expands single @mention inline", async () => {
    const result = await expandAtMentions("look at @hello.ts please", testDir);
    expect(result).toContain("<file: hello.ts>");
    expect(result).toContain("greeting");
    expect(result).not.toContain("@hello.ts");
  });

  test("expands multiple @mentions", async () => {
    const result = await expandAtMentions("check @hello.ts and @src/util.ts", testDir);
    expect(result).toContain("<file: hello.ts>");
    expect(result).toContain("<file: src/util.ts>");
  });

  test("inlines error for missing file", async () => {
    const result = await expandAtMentions("see @missing.ts", testDir);
    expect(result).toContain("[file not found");
    expect(result).not.toContain("@missing.ts");
  });

  test("preserves surrounding text", async () => {
    const result = await expandAtMentions("before @hello.ts after", testDir);
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  test("returns prompt unchanged when no @mentions", async () => {
    const prompt = "no mentions here";
    const result = await expandAtMentions(prompt, testDir);
    expect(result).toBe(prompt);
  });

  test("expands relative path (./)", async () => {
    const result = await expandAtMentions("see @./hello.ts", testDir);
    expect(result).toContain("<file:");
    expect(result).toContain("greeting");
  });
});
