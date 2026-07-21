import { describe, expect, it } from "vitest";

import { parseQuickTask } from "../src/natural-language";

const referenceDate = new Date(2026, 6, 20, 12, 0, 0);

describe("parseQuickTask", () => {
  it("turns inline metadata into structured task fields", () => {
    expect(
      parseQuickTask(
        "Review proposal tomorrow 25m !high /work /inbox",
        referenceDate,
      ),
    ).toEqual({
      title: "Review proposal",
      bucket: "inbox",
      priority: "high",
      area: "work",
      dueDate: "2026-07-21",
      estimateMinutes: 25,
    });
  });

  it("puts tasks due today in Today", () => {
    expect(parseQuickTask("Submit report today", referenceDate)).toMatchObject({
      title: "Submit report",
      bucket: "today",
      dueDate: "2026-07-20",
    });
  });

  it("rejects an estimate shorter than one minute", () => {
    expect(() => parseQuickTask("Impossible task 0m", referenceDate)).toThrow(
      "Estimate must be between 1 minute and 24 hours.",
    );
  });

  it("rejects quick entry without a task title", () => {
    expect(() => parseQuickTask("!high /work 25m", referenceDate)).toThrow(
      "Quick entry must contain a task title.",
    );
  });
});
