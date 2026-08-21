import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, themeById, themes } from "./themes";

const openCodeThemeFamilies = [
  "oc-2",
  "amoled",
  "aura",
  "ayu",
  "carbonfox",
  "catppuccin",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "cobalt2",
  "cursor",
  "dracula",
  "everforest",
  "flexoki",
  "github",
  "gruvbox",
  "kanagawa",
  "lucent-orng",
  "material",
  "matrix",
  "mercury",
  "monokai",
  "nightowl",
  "nord",
  "one-dark",
  "onedarkpro",
  "opencode",
  "orng",
  "osaka-jade",
  "palenight",
  "rosepine",
  "shadesofpurple",
  "solarized",
  "synthwave84",
  "tokyonight",
  "vercel",
  "vesper",
  "zenburn",
] as const;

const requiredThemeVariables = [
  "--accent",
  "--accent-hover",
  "--accent-soft",
  "--area-personal-fg",
  "--area-personal-mark",
  "--area-work-fg",
  "--area-work-mark",
  "--bg",
  "--blue",
  "--border",
  "--border-strong",
  "--danger",
  "--focus-ring",
  "--ok-fg",
  "--on-accent",
  "--orange",
  "--shadow",
  "--sidebar",
  "--surface",
  "--surface-hover",
  "--surface-raised",
  "--text",
  "--text-muted",
  "--text-secondary",
  "--text-strong",
  "--warn-fg",
] as const;

function relativeLuminance(hex: string): number {
  const value = hex.slice(1);
  const expanded = value.length === 3 ? value.split("").map((channel) => channel.repeat(2)).join("") : value;
  const channels = expanded.match(/.{2}/g)!.map((channel) => Number.parseInt(channel, 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function srgbDistance(first: string, second: string): number {
  const channels = (hex: string) => hex.slice(1).match(/.{2}/g)!.map((channel) => Number.parseInt(channel, 16));
  const a = channels(first);
  const b = channels(second);
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("themes", () => {
  it("offers both variants of every fixed OpenCode desktop-or-CLI theme family", () => {
    const expectedIds = openCodeThemeFamilies
      .flatMap((family) => [`${family}-light`, `${family}-dark`])
      .sort();
    const nativeThemeIds = ["superhuman", "graphite-dark", "graphite-light"];
    const actualIds = themes
      .map(({ id }) => id)
      .filter((id) => !nativeThemeIds.includes(id))
      .sort();

    expect(actualIds).toEqual(expectedIds);
  });

  it("lists graphite dark first so the palette fallback matches the default theme", () => {
    expect(themes[0]?.id).toBe("graphite-dark");
    expect(themeById("not-a-theme" as Parameters<typeof themeById>[0]).id).toBe("graphite-dark");
  });

  it("defines an identical variable key set for every theme", () => {
    // applyTheme sets inline properties and never clears, so a missing key would leak the previous theme's value.
    const expectedKeys = Object.keys(themes[0]!.variables).sort();
    for (const theme of themes) {
      expect(Object.keys(theme.variables).sort(), theme.id).toEqual(expectedKeys);
    }
  });

  it("applies an OpenCode light palette as a light document theme", () => {
    applyTheme("github-light");

    expect(document.documentElement.dataset.theme).toBe("github-light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--text")).toBe("#24292f");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#0969da");
  });

  it("applies an OpenCode dark palette as a dark document theme", () => {
    applyTheme("github-dark");

    expect(document.documentElement.dataset.theme).toBe("github-dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#0d1117");
    expect(document.documentElement.style.getPropertyValue("--text")).toBe("#c9d1d9");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#58a6ff");
  });

  it("resolves a genuinely light surface when an OpenCode family reuses dark seeds", () => {
    applyTheme("catppuccin-frappe-light");
    const background = document.documentElement.style.getPropertyValue("--bg");
    const text = document.documentElement.style.getPropertyValue("--text");

    expect(relativeLuminance(background)).toBeGreaterThan(0.7);
    expect(contrastRatio(background, text)).toBeGreaterThanOrEqual(4.5);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("builds theme swatches from the colors the app actually applies", () => {
    const theme = themeById("catppuccin-frappe-light");

    expect(theme.colors).toEqual([
      theme.variables["--bg"],
      theme.variables["--text"],
      theme.variables["--accent"],
      theme.variables["--blue"],
    ]);
    expect(relativeLuminance(theme.colors[0])).toBeGreaterThan(0.7);
  });

  it("applies the complete app color contract for every selectable theme", () => {
    for (const theme of themes) {
      document.documentElement.removeAttribute("style");
      applyTheme(theme.id);

      expect(document.documentElement.style.colorScheme, theme.id).toBe(theme.mode);
      for (const variable of requiredThemeVariables) {
        expect(document.documentElement.style.getPropertyValue(variable), `${theme.id} ${variable}`).not.toBe("");
      }

      const background = document.documentElement.style.getPropertyValue("--bg");
      const accent = document.documentElement.style.getPropertyValue("--accent");
      const accentHover = document.documentElement.style.getPropertyValue("--accent-hover");
      const surfaces = [
        background,
        document.documentElement.style.getPropertyValue("--surface"),
        document.documentElement.style.getPropertyValue("--surface-raised"),
      ];
      const focusBackgrounds = surfaces;
      for (const surface of surfaces) {
        expect(contrastRatio(surface, document.documentElement.style.getPropertyValue("--text-strong")), `${theme.id} strong text`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface, document.documentElement.style.getPropertyValue("--text-secondary")), `${theme.id} secondary text`).toBeGreaterThanOrEqual(5.5);
        expect(contrastRatio(surface, document.documentElement.style.getPropertyValue("--text-muted")), `${theme.id} muted text`).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of surfaces) {
        for (const area of ["work", "personal"] as const) {
          expect(contrastRatio(surface, document.documentElement.style.getPropertyValue(`--area-${area}-fg`)), `${theme.id} ${area} area label`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(surface, document.documentElement.style.getPropertyValue(`--area-${area}-mark`)), `${theme.id} ${area} area mark`).toBeGreaterThanOrEqual(3);
        }
        for (const status of ["--ok-fg", "--warn-fg"] as const) {
          expect(contrastRatio(surface, document.documentElement.style.getPropertyValue(status)), `${theme.id} ${status}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      const workMark = document.documentElement.style.getPropertyValue("--area-work-mark");
      const personalMark = document.documentElement.style.getPropertyValue("--area-personal-mark");
      expect(srgbDistance(workMark, personalMark), `${theme.id} area mark distinctness`).toBeGreaterThanOrEqual(64);
      for (const focusBackground of focusBackgrounds) {
        expect(contrastRatio(focusBackground, document.documentElement.style.getPropertyValue("--focus-ring")), `${theme.id} focus ring`).toBeGreaterThanOrEqual(3);
      }
      for (const accentBackground of [accent, accentHover]) {
        expect(contrastRatio(accentBackground, document.documentElement.style.getPropertyValue("--on-accent")), `${theme.id} accent foreground`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
