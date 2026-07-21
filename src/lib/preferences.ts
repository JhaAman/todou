import { defaultShortcuts } from "./shortcuts";
import type { AppPreferences, Area, ShortcutAction, ThemeId } from "./types";

const key = "todou.preferences.v1";

export const defaultPreferences: AppPreferences = {
  themeId: "superhuman",
  lastArea: "work",
  shortcuts: defaultShortcuts,
};

export function loadPreferences(): AppPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<AppPreferences>;
    return {
      themeId: (parsed.themeId ?? defaultPreferences.themeId) as ThemeId,
      lastArea: (parsed.lastArea ?? defaultPreferences.lastArea) as Area,
      shortcuts: { ...defaultShortcuts, ...(parsed.shortcuts as Partial<Record<ShortcutAction, string>> | undefined) },
    };
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(preferences: AppPreferences): void {
  localStorage.setItem(key, JSON.stringify(preferences));
}
