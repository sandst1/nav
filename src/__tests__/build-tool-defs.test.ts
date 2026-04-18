/**
 * Tool registry: plan-only tools are omitted unless explicitly requested.
 */

import { expect, test, describe } from "bun:test";
import { buildToolDefs } from "../tools/index";

describe("buildToolDefs", () => {
  test("excludes ask_user by default", () => {
    const defs = buildToolDefs("hashline");
    expect(defs.some((d) => d.name === "ask_user")).toBe(false);
  });

  test("excludes ask_user when includeAskUserTool is false", () => {
    const defs = buildToolDefs("hashline", { includeAskUserTool: false });
    expect(defs.some((d) => d.name === "ask_user")).toBe(false);
  });

  test("includes ask_user when includeAskUserTool is true", () => {
    const defs = buildToolDefs("hashline", { includeAskUserTool: true });
    const ask = defs.find((d) => d.name === "ask_user");
    expect(ask).toBeDefined();
    expect(ask!.name).toBe("ask_user");
  });
});
