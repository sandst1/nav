import { describe, expect, test } from "bun:test";
import { parsePlanDraft } from "./plans";

describe("parsePlanDraft", () => {
  test("happy path: frontmatter and body", () => {
    const text =
      "Here is the plan.\n\n" +
      "---\n" +
      "name: My Plan\n" +
      "description: One line summary\n" +
      "---\n\n" +
      "## Approach\n\nDo the thing.";
    const r = parsePlanDraft(text);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("My Plan");
    expect(r!.description).toBe("One line summary");
    expect(r!.approach).toBe("## Approach\n\nDo the thing.");
  });

  test("multiline body preserved", () => {
    const text =
      "---\n" +
      "name: A\n" +
      "description: B\n" +
      "---\n\n" +
      "Line1\n\n" +
      "Line2\n" +
      "Line3";
    const r = parsePlanDraft(text);
    expect(r!.approach).toBe("Line1\n\nLine2\nLine3");
  });

  test("last valid document wins when multiple", () => {
    const text =
      "---\nname: First\ndescription: D1\n---\nBody one\n\n" +
      "---\nname: Second\ndescription: D2\n---\nBody two";
    const r = parsePlanDraft(text);
    expect(r!.name).toBe("Second");
    expect(r!.approach).toBe("Body two");
  });

  test("returns null when name missing", () => {
    const text = "---\ndescription: only desc\n---\nSome body";
    expect(parsePlanDraft(text)).toBeNull();
  });

  test("returns null when description missing", () => {
    const text = "---\nname: only name\n---\nSome body";
    expect(parsePlanDraft(text)).toBeNull();
  });

  test("returns null when body empty", () => {
    const text = "---\nname: N\ndescription: D\n---\n   \n";
    expect(parsePlanDraft(text)).toBeNull();
  });

  test("returns null with no frontmatter", () => {
    expect(parsePlanDraft("Just prose, no fences.")).toBeNull();
  });

  test("extra frontmatter keys ignored", () => {
    const text =
      "---\n" +
      "name: N\n" +
      "description: D\n" +
      "author: nobody\n" +
      "---\n\nBody";
    const r = parsePlanDraft(text);
    expect(r!.name).toBe("N");
    expect(r!.description).toBe("D");
    expect(r!.approach).toBe("Body");
  });

  test("returns null when opening --- has no closing ---", () => {
    const text = "---\nname: N\ndescription: D\nNo closing fence";
    expect(parsePlanDraft(text)).toBeNull();
  });

  test("CRLF normalized", () => {
    const text = "---\r\nname: X\r\ndescription: Y\r\n---\r\n\r\nZ";
    const r = parsePlanDraft(text);
    expect(r!.approach).toBe("Z");
  });
});
