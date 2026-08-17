import { defaultShortcuts } from "./shortcuts";
import { isThemeId } from "./themes";
import type { AppPreferences, Area, ShortcutAction, ThemeId } from "./types";

const key = "todou.preferences.v1";
const quickEntryMigrationKey = "todou.preferences.quick-entry-default-migrated.v1";
const legacyQuickEntryShortcut = "Ctrl+Space";

export const defaultPreferences: AppPreferences = {
  themeId: "superhuman",
  lastArea: "work",
  shortcuts: defaultShortcuts,
};

const legacyThemeIds: Record<string, ThemeId> = {
  catppuccin: "catppuccin-dark",
  dracula: "dracula-dark",
  nord: "nord-dark",
  "tokyo-night": "tokyonight-dark",
  gruvbox: "gruvbox-dark",
  "one-dark": "one-dark-dark",
  solarized: "solarized-dark",
};

function loadThemeId(value: unknown): ThemeId {
  const migrated = typeof value === "string" ? (legacyThemeIds[value] ?? value) : undefined;
  return isThemeId(migrated) ? migrated : defaultPreferences.themeId;
}

export function loadPreferences(): AppPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<AppPreferences>;
    const savedShortcuts = parsed.shortcuts as Partial<Record<ShortcutAction, string>> | undefined;
    const shouldMigrateQuickEntry = localStorage.getItem(quickEntryMigrationKey) === null
      && savedShortcuts?.quickEntry === legacyQuickEntryShortcut;
    return {
      themeId: loadThemeId(parsed.themeId),
      lastArea: (parsed.lastArea ?? defaultPreferences.lastArea) as Area,
      shortcuts: {
        ...defaultShortcuts,
        ...savedShortcuts,
        ...(shouldMigrateQuickEntry ? { quickEntry: defaultShortcuts.quickEntry } : {}),
      },
    };
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(preferences: AppPreferences): void {
  localStorage.setItem(key, JSON.stringify(preferences));
  localStorage.setItem(quickEntryMigrationKey, "true");
}
