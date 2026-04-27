/**
 * Tool registry: plan-only tools are omitted unless explicitly requested.
 */

import { expect, test, describe } from "bun:test";
import { buildToolDefs, filterToolDefs, subagentToolDef, getToolDefs } from "../tools/index";

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

  test("includes subagent by default", () => {
    const defs = buildToolDefs("hashline");
    expect(defs.some((d) => d.name === "subagent")).toBe(true);
    expect(defs.find((d) => d.name === "subagent")?.name).toBe(subagentToolDef.name);
  });

  test("allowedToolNames filters to listed tools only", () => {
    const defs = buildToolDefs("hashline", { allowedToolNames: ["read", "shell", "subagent"] });
    expect(defs.map((d) => d.name).sort()).toEqual(["read", "shell", "subagent"]);
  });

  test("allowedToolNames with includeAskUserTool", () => {
    const defs = buildToolDefs("hashline", {
      includeAskUserTool: true,
      allowedToolNames: ["read", "ask_user"],
    });
    expect(defs.map((d) => d.name).sort()).toEqual(["ask_user", "read"]);
  });

  test("getToolDefs includes subagent", () => {
    const names = getToolDefs().map((d) => d.name);
    expect(names).toContain("subagent");
  });

  test("filterToolDefs", () => {
    const all = buildToolDefs("hashline");
    const filtered = filterToolDefs(all, new Set(["write"]));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("write");
  });
});
