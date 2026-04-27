import { expect, test, describe } from "bun:test";
import {
  normalizeAllowedToolsList,
  parseSubagentFileValues,
  resolveSubagentRuntimeConfig,
  type Config,
} from "../config";

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    provider: "openai",
    model: "gpt-4.1",
    apiKey: "k",
    verbose: false,
    sandbox: false,
    cwd: "/tmp",
    handoverThreshold: 0.8,
    ollamaBatchSize: 1024,
    hookTimeoutMs: 600_000,
    taskImplementationMaxAttempts: 3,
    editMode: "hashline",
    ...over,
  };
}

describe("normalizeAllowedToolsList", () => {
  test("undefined input returns undefined", () => {
    expect(normalizeAllowedToolsList(undefined, "tools")).toBeUndefined();
  });

  test("filters unknown tool names", () => {
    const list = normalizeAllowedToolsList(["read", "not_a_real_tool", "shell"], "tools");
    expect(list).toEqual(["read", "shell"]);
  });

  test("empty array returns empty list", () => {
    expect(normalizeAllowedToolsList([], "tools")).toEqual([]);
  });
});

describe("parseSubagentFileValues", () => {
  test("parses model and tools", () => {
    const v = parseSubagentFileValues(
      { model: "claude-3-5-haiku-20241022", tools: ["read", "edit"] },
      "x.json",
    );
    expect(v?.model).toBe("claude-3-5-haiku-20241022");
    expect(v?.tools).toEqual(["read", "edit"]);
  });
});

describe("resolveSubagentRuntimeConfig", () => {
  test("returns parent when defaults undefined", () => {
    const p = baseConfig({ allowedTools: ["read"] });
    expect(resolveSubagentRuntimeConfig(p, undefined)).toBe(p);
  });

  test("overlays model from subagent block", () => {
    const p = baseConfig({ model: "gpt-4.1", provider: "openai" });
    const c = resolveSubagentRuntimeConfig(p, { model: "claude-3-5-haiku-20241022" });
    expect(c.model).toBe("claude-3-5-haiku-20241022");
    expect(c.provider).toBe("anthropic");
  });

  test("inherits parent allowedTools when subagent.tools omitted", () => {
    const p = baseConfig({ allowedTools: ["read", "shell"] });
    const c = resolveSubagentRuntimeConfig(p, { model: "gpt-4.1" });
    expect(c.allowedTools).toEqual(["read", "shell"]);
  });
});
