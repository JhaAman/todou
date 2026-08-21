import { describe, expect, it } from "vitest";
import { defaultShortcuts, shortcutMatches } from "./shortcuts";

function keyboardEvent(key: string, modifiers: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...modifiers });
}

describe("shortcut matching", () => {
  it("uses the Things-safe Quick Entry default", () => {
    expect(defaultShortcuts.quickEntry).toBe("Ctrl+Shift+Space");
  });

  it("gives In Progress a unique default shortcut", () => {
    expect(defaultShortcuts.moveInProgress).toBe("Meta+Shift+G");
    expect(new Set(Object.values(defaultShortcuts))).toHaveLength(Object.keys(defaultShortcuts).length);
  });

  it("matches defaults regardless of the stored modifier order", () => {
    expect(shortcutMatches(
      keyboardEvent("T", { metaKey: true, shiftKey: true }),
      defaultShortcuts.moveToday,
    )).toBe(true);
    expect(shortcutMatches(
      keyboardEvent("P", { metaKey: true, shiftKey: true }),
      defaultShortcuts.togglePriority,
    )).toBe(true);
  });

  it("does not match when a required modifier is absent", () => {
    expect(shortcutMatches(
      keyboardEvent("T", { metaKey: true }),
      defaultShortcuts.moveToday,
    )).toBe(false);
  });
});
