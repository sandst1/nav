/**
 * Ui-server `systemPromptPrefix` composition: must stay aligned with `buildSystemPrompt`
 * so CLI behavior (no prefix) is unchanged and role threads get a stable prefix + base.
 */

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSystemPrompt,
  buildSystemPromptWithOptionalRolePrefix,
} from "../prompt";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `nav-prompt-role-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("buildSystemPromptWithOptionalRolePrefix", () => {
  test("no prefix matches buildSystemPrompt (undefined)", () => {
    for (const editMode of ["hashline", "searchReplace"] as const) {
      const expected = buildSystemPrompt(testDir, editMode);
      expect(buildSystemPromptWithOptionalRolePrefix(testDir, editMode, undefined)).toBe(expected);
    }
  });

  test("whitespace-only prefix matches buildSystemPrompt", () => {
    for (const editMode of ["hashline", "searchReplace"] as const) {
      const expected = buildSystemPrompt(testDir, editMode);
      expect(buildSystemPromptWithOptionalRolePrefix(testDir, editMode, "   \t  ")).toBe(expected);
    }
  });

  test("non-empty prefix prepends role and uses omitNavRole base", () => {
    const role = "You are a focused reviewer.";
    for (const editMode of ["hashline", "searchReplace"] as const) {
      const baseOmit = buildSystemPrompt(testDir, editMode, { omitNavRole: true });
      const got = buildSystemPromptWithOptionalRolePrefix(testDir, editMode, role);
      expect(got).toBe(`${role}\n\n${baseOmit}`);
    }
  });

  test("prefix is trimmed", () => {
    const role = "Custom role";
    const baseOmit = buildSystemPrompt(testDir, "hashline", { omitNavRole: true });
    expect(buildSystemPromptWithOptionalRolePrefix(testDir, "hashline", `  ${role}  `)).toBe(
      `${role}\n\n${baseOmit}`,
    );
  });
});
