/**
 * Tests for search-replace edit semantics (literal substring).
 */

import { expect, test, describe } from "bun:test";
import {
  applySearchReplaceContent,
  countLiteralOccurrences,
} from "../tools/edit";

describe("countLiteralOccurrences", () => {
  test("returns 0 for empty needle", () => {
    expect(countLiteralOccurrences("abc", "")).toBe(0);
  });

  test("counts non-overlapping occurrences", () => {
    expect(countLiteralOccurrences("ababab", "ab")).toBe(3);
    expect(countLiteralOccurrences("aaa", "aa")).toBe(1);
  });
});

describe("applySearchReplaceContent", () => {
  test("rejects empty old_string", () => {
    expect(() => applySearchReplaceContent("hi", "", "x", false)).toThrow(/old_string cannot be empty/);
  });

  test("throws when not found", () => {
    expect(() => applySearchReplaceContent("hello", "z", "y", false)).toThrow(/not found/);
  });

  test("throws when ambiguous without replace_all", () => {
    expect(() => applySearchReplaceContent("foo foo", "foo", "bar", false)).toThrow(/matched 2 times/);
  });

  test("replaces first only when unique", () => {
    expect(applySearchReplaceContent("foo bar foo", "bar", "BAZ", false)).toBe("foo BAZ foo");
  });

  test("replace_all replaces every occurrence", () => {
    expect(applySearchReplaceContent("foo foo", "foo", "bar", true)).toBe("bar bar");
  });

  test("allows empty new_string", () => {
    expect(applySearchReplaceContent("removeX", "X", "", false)).toBe("remove");
  });
});
