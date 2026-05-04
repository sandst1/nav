import { describe, expect, test } from "bun:test";
import { parsePlanTasks, parsePlanTasksFromMarkdown } from "./tasks";

describe("parsePlanTasksFromMarkdown", () => {
  test("single task without optional fields", () => {
    const md = "## Do the thing\n\nWire up the handler.";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks).not.toBeNull();
    expect(tasks!.length).toBe(1);
    expect(tasks![0]!.name).toBe("Do the thing");
    expect(tasks![0]!.description).toBe("Wire up the handler.");
    expect(tasks![0]!.relatedFiles).toBeUndefined();
    expect(tasks![0]!.acceptanceCriteria).toBeUndefined();
  });

  test("multiple tasks separated by ---", () => {
    const md =
      "## First\n\nDesc one\n\n---\n\n" +
      "## Second\n**Files:** a.ts, b.ts\n\nDesc two";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks!.length).toBe(2);
    expect(tasks![0]!.name).toBe("First");
    expect(tasks![1]!.name).toBe("Second");
    expect(tasks![1]!.relatedFiles).toEqual(["a.ts", "b.ts"]);
  });

  test("**Files:** comma-split and trimmed", () => {
    const md = "## T\n**Files:**  src/a.ts  , src/b.ts  \n\nDone.";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks![0]!.relatedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("**Criteria:** bullets become acceptanceCriteria", () => {
    const md =
      "## T\n\nDo work.\n\n" +
      "**Criteria:**\n" +
      "- First check\n" +
      "- Second check\n";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks![0]!.acceptanceCriteria).toEqual(["First check", "Second check"]);
  });

  test("criterion with comma stays one string", () => {
    const md =
      "## T\n\nDesc.\n\n**Criteria:**\n" +
      "- Returns 403 for expired token, even if well-formed\n";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks![0]!.acceptanceCriteria!.length).toBe(1);
    expect(tasks![0]!.acceptanceCriteria![0]).toContain("403");
    expect(tasks![0]!.acceptanceCriteria![0]).toContain(",");
  });

  test("sections without ## heading are skipped", () => {
    const md = "Intro without heading\n\n---\n\n## Real\n\nBody";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks!.length).toBe(1);
    expect(tasks![0]!.name).toBe("Real");
  });

  test("empty description allowed when name present", () => {
    const md = "## Name only\n\n**Criteria:**\n- One thing\n";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks![0]!.description).toBe("");
    expect(tasks![0]!.acceptanceCriteria).toEqual(["One thing"]);
  });

  test("multiple ## headings without --- delimiter", () => {
    const md = "Intro\n\n## One\n\nA\n\n## Two\n\nB";
    const tasks = parsePlanTasksFromMarkdown(md);
    expect(tasks!.length).toBe(2);
    expect(tasks![0]!.name).toBe("One");
    expect(tasks![1]!.name).toBe("Two");
  });
});

describe("parsePlanTasks", () => {
  test("prefers JSON array when valid (microsplit-style)", () => {
    const text =
      'Some prose\n```json\n[\n  {"name": "J", "description": "D", "relatedFiles": ["x.ts"]}\n]\n```';
    const tasks = parsePlanTasks(text);
    expect(tasks!.length).toBe(1);
    expect(tasks![0]!.name).toBe("J");
    expect(tasks![0]!.relatedFiles).toEqual(["x.ts"]);
  });

  test("falls back to markdown when JSON absent", () => {
    const md = "## M\n\nMarkdown only.";
    const tasks = parsePlanTasks(md);
    expect(tasks![0]!.name).toBe("M");
  });
});
