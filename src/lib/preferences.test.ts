import { beforeEach, describe, expect, it } from "vitest";
import { defaultPreferences, loadPreferences, savePreferences } from "./preferences";

const storageKey = "todou.preferences.v1";

beforeEach(() => localStorage.clear());

describe("theme preferences", () => {
  it("migrates a saved legacy dark theme to its explicit OpenCode variant", () => {
    localStorage.setItem(storageKey, JSON.stringify({ themeId: "tokyo-night" }));

    expect(loadPreferences().themeId).toBe("tokyonight-dark");
  });

  it("falls back from an unknown saved theme instead of retaining an unusable id", () => {
    localStorage.setItem(storageKey, JSON.stringify({ themeId: "not-a-theme" }));

    expect(loadPreferences().themeId).toBe(defaultPreferences.themeId);
  });
});

describe("quick-entry shortcut migration", () => {
  it("replaces the legacy default while preserving the other saved preferences", () => {
    localStorage.setItem(storageKey, JSON.stringify({
      themeId: "oc-2-light",
      lastArea: "personal",
      shortcuts: { newTask: "Meta+Shift+N", quickEntry: "Ctrl+Space" },
    }));

    expect(loadPreferences()).toMatchObject({
      themeId: "oc-2-light",
      lastArea: "personal",
      shortcuts: { newTask: "Meta+Shift+N", quickEntry: "Ctrl+Shift+Space" },
    });
  });

  it("preserves a custom quick-entry shortcut from legacy preferences", () => {
    localStorage.setItem(storageKey, JSON.stringify({
      shortcuts: { quickEntry: "Ctrl+Shift+Q" },
    }));

    expect(loadPreferences().shortcuts.quickEntry).toBe("Ctrl+Shift+Q");
  });

  it("does not remigrate Ctrl-Space after preferences have been saved by the new version", () => {
    savePreferences({
      ...defaultPreferences,
      shortcuts: { ...defaultPreferences.shortcuts, quickEntry: "Ctrl+Space" },
    });

    expect(loadPreferences().shortcuts.quickEntry).toBe("Ctrl+Space");
  });
});
