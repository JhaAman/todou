import { beforeEach, describe, expect, it } from "vitest";
import { defaultPreferences, loadPreferences } from "./preferences";

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
