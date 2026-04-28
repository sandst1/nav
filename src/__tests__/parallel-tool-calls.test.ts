import { describe, expect, test } from "bun:test";
import { runWithConcurrency } from "../parallel-limit";
import {
  parseParallelToolCallsFromFile,
  resolveConfig,
  withSubagentNestedToolLimits,
  MAX_PARALLEL_TOOL_CALLS,
  type Config,
} from "../config";

function minimalConfig(over: Partial<Config> = {}): Config {
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
    parallelToolCalls: 1,
    ...over,
  };
}

describe("runWithConcurrency", () => {
  test("preserves result order", async () => {
    const items = [10, 20, 30, 40];
    const out = await runWithConcurrency(items, 2, async (x, i) => {
      await new Promise((r) => setTimeout(r, 1));
      return x + i;
    });
    expect(out).toEqual([10, 21, 32, 43]);
  });

  test("respects concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const indices = [0, 1, 2, 3, 4, 5];
    await runWithConcurrency(indices, 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 8));
      active--;
    });
    expect(peak).toBe(2);
  });

  test("empty input", async () => {
    expect(await runWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("parseParallelToolCallsFromFile", () => {
  test("undefined returns undefined", () => {
    expect(parseParallelToolCallsFromFile(undefined, "x")).toBeUndefined();
  });

  test("parses integer", () => {
    expect(parseParallelToolCallsFromFile(4, "x")).toBe(4);
  });

  test("clamps high values", () => {
    expect(parseParallelToolCallsFromFile(999, "x")).toBe(MAX_PARALLEL_TOOL_CALLS);
  });
});

describe("withSubagentNestedToolLimits", () => {
  test("forces parallelToolCalls to 1", () => {
    const c = minimalConfig({ parallelToolCalls: 8 });
    expect(withSubagentNestedToolLimits(c).parallelToolCalls).toBe(1);
  });
});

describe("resolveConfig parallelToolCalls", () => {
  test("defaults to 1", () => {
    const c = resolveConfig({}, {});
    expect(c.parallelToolCalls).toBe(1);
  });

  test("reads from file when env unset", () => {
    const prev = process.env.NAV_PARALLEL_TOOL_CALLS;
    delete process.env.NAV_PARALLEL_TOOL_CALLS;
    try {
      const c = resolveConfig({}, { parallelToolCalls: 5 });
      expect(c.parallelToolCalls).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.NAV_PARALLEL_TOOL_CALLS;
      else process.env.NAV_PARALLEL_TOOL_CALLS = prev;
    }
  });
});
