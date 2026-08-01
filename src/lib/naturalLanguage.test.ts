import { describe, expect, it } from "vitest";
import { formatEstimate, parseEstimate, parseNaturalLanguage } from "./naturalLanguage";

const referenceDate = new Date(2026, 6, 20, 9, 0, 0);

describe("natural-language capture", () => {
  it("extracts explicit Todou tokens without dropping the task title", () => {
    const parsed = parseNaturalLanguage("Review proposal tomorrow 25m !high /work", referenceDate);

    expect(parsed.title).toBe("Review proposal");
    expect(parsed.fields).toMatchObject({
      dueDate: "2026-07-21",
      estimateMinutes: 25,
      priority: "high",
      area: "work",
    });
    expect(parsed.tokens.map((token) => token.label)).toEqual(["Tomorrow", "25m", "High", "Work"]);
  });

  it("keeps ambiguous words in the title", () => {
    const parsed = parseNaturalLanguage("Maybe review the someday list", referenceDate);

    expect(parsed.title).toBe("Maybe review the someday list");
    expect(parsed.fields.dueDate).toBeUndefined();
  });

  it("resolves Monday forward without placing it in Today", () => {
    const parsed = parseNaturalLanguage("Prepare on monday", new Date(2026, 6, 21, 9, 0, 0));

    expect(parsed.fields).toMatchObject({ dueDate: "2026-07-27" });
    expect(parsed.fields.bucket).toBeUndefined();
  });

  it("moves due-today capture into Today", () => {
    const parsed = parseNaturalLanguage("Call Jordan today /inbox", referenceDate);

    expect(parsed.fields.dueDate).toBe("2026-07-20");
    expect(parsed.fields.bucket).toBe("today");
  });

  it("treats the explicit Today token as a due-today capture", () => {
    const parsed = parseNaturalLanguage("Call Jordan /today", referenceDate);

    expect(parsed.fields).toMatchObject({
      bucket: "today",
      dueDate: "2026-07-20",
    });
  });

  it("normalizes hour and minute estimates", () => {
    expect(parseEstimate("1h 25m")).toBe(85);
    expect(formatEstimate(85)).toBe("1h 25m");
  });

  it("rejects estimates outside the supported day range", () => {
    expect(parseEstimate("0m")).toBeNull();
    expect(parseEstimate("25h")).toBeNull();
  });
});
