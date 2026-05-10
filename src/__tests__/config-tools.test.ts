import { expect, test, describe } from "bun:test";
import {
  applySubagentNestedPolicy,
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
    planMode: "specs",
    parallelToolCalls: 1,
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

  test("parses allowNestedSubagents boolean", () => {
    const v = parseSubagentFileValues(
      { allowNestedSubagents: true },
      "x.json",
    );
    expect(v?.allowNestedSubagents).toBe(true);
  });
});

describe("applySubagentNestedPolicy", () => {
  test("nested enabled keeps undefined allowlist unchanged", () => {
    const tools = applySubagentNestedPolicy(undefined, true);
    expect(tools).toBeUndefined();
  });

  test("nested disabled expands undefined allowlist without subagent", () => {
    const tools = applySubagentNestedPolicy(undefined, false);
    expect(tools).toBeDefined();
    expect(tools).not.toContain("subagent");
    expect(tools).not.toContain("ask_user");
    expect(tools).toContain("read");
    expect(tools).toContain("shell");
  });

  test("nested disabled strips subagent from explicit allowlist", () => {
    const tools = applySubagentNestedPolicy(["read", "subagent", "shell"], false);
    expect(tools).toEqual(["read", "shell"]);
  });

  test("nested enabled preserves explicit allowlist", () => {
    const tools = applySubagentNestedPolicy(["read", "subagent", "shell"], true);
    expect(tools).toEqual(["read", "subagent", "shell"]);
  });
});

describe("resolveSubagentRuntimeConfig", () => {
  test("returns parent when defaults undefined", () => {
    const p = baseConfig({ allowedTools: ["read"] });
    expect(resolveSubagentRuntimeConfig(p, undefined)).toBe(p);
  });

  test("overlays model from subagent block; inherits parent provider", () => {
    const p = baseConfig({ model: "gpt-4.1", provider: "openai" });
    const c = resolveSubagentRuntimeConfig(p, { model: "gpt-4o-mini" });
    expect(c.model).toBe("gpt-4o-mini");
    expect(c.provider).toBe("openai");
  });

  test("model-only keeps parent baseUrl and contextWindow", () => {
    const p = baseConfig({
      provider: "openai",
      model: "gpt-4.1",
      baseUrl: "https://proxy.example/v1",
      contextWindow: 50_000,
    });
    const c = resolveSubagentRuntimeConfig(p, { model: "gpt-4o-mini" });
    expect(c.model).toBe("gpt-4o-mini");
    expect(c.provider).toBe("openai");
    expect(c.baseUrl).toBe("https://proxy.example/v1");
    expect(c.contextWindow).toBe(50_000);
    expect(c.apiKey).toBe("k");
  });

  test("subagent.provider overrides parent", () => {
    const p = baseConfig({ provider: "openai", model: "gpt-4.1", apiKey: "openai-key" });
    const c = resolveSubagentRuntimeConfig(p, {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
    });
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-3-5-haiku-20241022");
  });

  test("subagent.contextWindow overrides parent", () => {
    const p = baseConfig({ model: "gpt-4.1", contextWindow: 128_000 });
    const c = resolveSubagentRuntimeConfig(p, { contextWindow: 32_000 });
    expect(c.contextWindow).toBe(32_000);
  });

  test("inherits parent allowedTools when subagent.tools omitted", () => {
    const p = baseConfig({ allowedTools: ["read", "shell"] });
    const c = resolveSubagentRuntimeConfig(p, { model: "gpt-4.1" });
    expect(c.allowedTools).toEqual(["read", "shell"]);
  });
});
