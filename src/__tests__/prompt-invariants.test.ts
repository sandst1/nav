/**
 * Behavioral cues in compressed prompts — not full-string snapshots.
 */

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../prompt";
import { buildToolDefs } from "../tools/index";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `nav-prompt-inv-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("buildSystemPrompt invariants", () => {
  test("hashline mode keeps anchor semantics", () => {
    const p = buildSystemPrompt(testDir, "hashline");
    expect(p).toContain("LINE:HASH");
    expect(p).toContain("You are nav");
    expect(p).toContain("Shell:");
  });

  test("searchReplace mode keeps literal-edit semantics", () => {
    const p = buildSystemPrompt(testDir, "searchReplace");
    expect(p).toContain("Plain text from read");
    expect(p).toContain("old_string");
  });
});

describe("buildToolDefs invariants", () => {
  test("hashline edit tool still documents anchors", () => {
    const defs = buildToolDefs("hashline");
    const edit = defs.find((d) => d.name === "edit");
    expect(edit?.description).toContain("LINE:HASH");
  });

  test("searchReplace edit tool still documents old_string", () => {
    const defs = buildToolDefs("searchReplace");
    const edit = defs.find((d) => d.name === "edit");
    expect(edit?.description).toContain("old_string");
  });
});
