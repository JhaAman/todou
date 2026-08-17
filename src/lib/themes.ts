import {
  OPEN_CODE_THEME_FAMILY_IDS,
  openCodeThemePalettes,
  type OpenCodeThemeMode,
  type OpenCodeThemePalette,
} from "./opencodeThemePalettes";
import type { ThemeId } from "./types";

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  mode: OpenCodeThemeMode;
  colors: [string, string, string, string];
  variables: Record<string, string>;
}

const superhumanTheme: ThemeDefinition = {
  id: "superhuman",
  name: "Superhuman",
  description: "Todou's original ink, violet, and electric blue",
  mode: "dark",
  colors: ["#0b0d12", "#171a22", "#8b7cf6", "#65a8ff"],
  variables: {
    "--bg": "#0b0d12",
    "--sidebar": "#0e1016",
    "--surface": "#12151c",
    "--surface-raised": "#181c25",
    "--surface-hover": "#1d222d",
    "--border": "#242a36",
    "--border-strong": "#353d4c",
    "--text": "#f3f4f7",
    "--text-strong": "#f3f4f7",
    "--text-secondary": "#a6adba",
    "--text-muted": "#7f8798",
    "--accent": "#8b7cf6",
    "--accent-hover": "#9487f7",
    "--accent-soft": "#8b7cf629",
    "--blue": "#65a8ff",
    "--orange": "#f5a45d",
    "--danger": "#ef7272",
    "--focus-ring": "#ffffff",
    "--on-accent": "#000000",
    "--shadow": "#00000073",
    "--area-work-mark": "#41d9ff",
    "--area-personal-mark": "#ff5bd8",
    "--area-work-fg": mix("#41d9ff", "#f3f4f7", 0.5),
    "--area-personal-fg": mix("#ff5bd8", "#f3f4f7", 0.5),
  },
};

function hexChannels(hex: string): [number, number, number] {
  const value = hex.slice(1);
  const expanded = value.length === 3 || value.length === 4
    ? value.slice(0, 3).split("").map((channel) => channel.repeat(2)).join("")
    : value.slice(0, 6);
  const parsed = Number.parseInt(expanded, 16);
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function mix(base: string, overlay: string, amount: number): string {
  const baseChannels = hexChannels(base);
  const overlayChannels = hexChannels(overlay);
  const channels = baseChannels.map((channel, index) =>
    Math.round(channel + (overlayChannels[index]! - channel) * amount),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(hex: string): number {
  const channels = hexChannels(hex).map((channel) => channel / 255);
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

function mixUntil(
  color: string,
  target: string,
  condition: (candidate: string) => boolean,
): string {
  if (condition(color)) return color;
  let lower = 0;
  let upper = 1;
  for (let index = 0; index < 16; index += 1) {
    const amount = (lower + upper) / 2;
    if (condition(mix(color, target, amount))) upper = amount;
    else lower = amount;
  }
  return mix(color, target, upper);
}

function resolveBackground(neutral: string, mode: OpenCodeThemeMode): string {
  if (mode === "dark") return neutral;
  return mixUntil(neutral, "#ffffff", (candidate) => relativeLuminance(candidate) >= 0.82);
}

function ensureContrast(background: string, color: string, target: string, minimum: number): string {
  return mixUntil(color, target, (candidate) => contrastRatio(background, candidate) >= minimum);
}

function ensureContrastAcross(backgrounds: string[], color: string, target: string, minimum: number): string {
  return mixUntil(color, target, (candidate) =>
    backgrounds.every((background) => contrastRatio(background, candidate) >= minimum),
  );
}

// The area chip paints its label over a 10% tint of its own mark, so the guard has to clear that tint too.
function areaTokens(seed: string, surfaces: string[], text: string): { mark: string; foreground: string } {
  const mark = ensureContrastAcross(surfaces, seed, text, 3);
  const chipSurfaces = surfaces.flatMap((surface) => [surface, mix(surface, mark, 0.1)]);
  return { mark, foreground: ensureContrastAcross(chipSurfaces, mark, text, 4.5) };
}

function contrastingText(background: string): string {
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff")
    ? "#000000"
    : "#ffffff";
}

function withAlpha(hex: string, alpha: number): string {
  const [red, green, blue] = hexChannels(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function resolveVariables(palette: OpenCodeThemePalette, mode: OpenCodeThemeMode): Record<string, string> {
  const isDark = mode === "dark";
  const background = resolveBackground(palette.neutral, mode);
  const text = ensureContrast(background, palette.ink, isDark ? "#ffffff" : "#000000", 7);
  const sidebar = mix(background, text, isDark ? 0.025 : 0.018);
  const surface = mix(background, text, isDark ? 0.045 : 0.03);
  const raisedSurface = mix(background, text, isDark ? 0.075 : 0.055);
  const hoverSurface = mix(background, text, isDark ? 0.12 : 0.09);
  const textSurfaces = [background, surface, raisedSurface];
  const secondaryText = ensureContrastAcross(textSurfaces, mix(background, text, 0.76), text, 5.5);
  const mutedText = ensureContrastAcross(textSurfaces, mix(background, text, 0.52), text, 4.5);
  const work = areaTokens(palette.info, textSurfaces, text);
  const personal = areaTokens(palette.accent ?? palette.primary, textSurfaces, text);
  const focusRing = contrastingText(background);
  const onAccent = contrastingText(palette.primary);
  const accentHover = mix(palette.primary, onAccent === "#000000" ? "#ffffff" : "#000000", 0.08);
  return {
    "--bg": background,
    "--sidebar": sidebar,
    "--surface": surface,
    "--surface-raised": raisedSurface,
    "--surface-hover": hoverSurface,
    "--border": mix(background, text, isDark ? 0.17 : 0.14),
    "--border-strong": mix(background, text, isDark ? 0.3 : 0.25),
    "--text": text,
    "--text-strong": text,
    "--text-secondary": secondaryText,
    "--text-muted": mutedText,
    "--accent": palette.primary,
    "--accent-hover": accentHover,
    "--accent-soft": withAlpha(palette.primary, isDark ? 0.2 : 0.14),
    "--blue": palette.interactive ?? palette.info,
    "--orange": palette.warning,
    "--danger": palette.error,
    "--focus-ring": focusRing,
    "--on-accent": onAccent,
    "--shadow": withAlpha(isDark ? "#000000" : palette.ink, isDark ? 0.48 : 0.18),
    "--area-work-mark": work.mark,
    "--area-personal-mark": personal.mark,
    "--area-work-fg": work.foreground,
    "--area-personal-fg": personal.foreground,
  };
}

const openCodeThemes: ThemeDefinition[] = OPEN_CODE_THEME_FAMILY_IDS.flatMap((familyId) => {
  const family = openCodeThemePalettes[familyId];
  return (["light", "dark"] as const).map((mode) => {
    const palette: OpenCodeThemePalette = family[mode];
    const variables = resolveVariables(palette, mode);
    return {
      id: `${familyId}-${mode}`,
      name: `${family.name} ${mode === "light" ? "Light" : "Dark"}`,
      description: `OpenCode ${mode} palette`,
      mode,
      colors: [variables["--bg"]!, variables["--text"]!, variables["--accent"]!, variables["--blue"]!],
      variables,
    } satisfies ThemeDefinition;
  });
});

export const themes: ThemeDefinition[] = [superhumanTheme, ...openCodeThemes];

const themesById = new Map(themes.map((theme) => [theme.id, theme]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && themesById.has(value as ThemeId);
}

export function applyTheme(themeId: ThemeId): void {
  const theme = themeById(themeId);
  document.documentElement.dataset.theme = theme.id;
  for (const [name, value] of Object.entries(theme.variables)) {
    document.documentElement.style.setProperty(name, value);
  }
  document.documentElement.style.colorScheme = theme.mode;
}

export function themeById(themeId: ThemeId): ThemeDefinition {
  return themesById.get(themeId) ?? superhumanTheme;
}
