import type { ThemeId } from "./types";

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  colors: [string, string, string, string];
  variables: Record<string, string>;
}

export const themes: ThemeDefinition[] = [
  {
    id: "superhuman",
    name: "Superhuman",
    description: "Ink, violet, and electric blue",
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
      "--text-secondary": "#a6adba",
      "--text-muted": "#6e7686",
      "--accent": "#8b7cf6",
      "--accent-soft": "#8b7cf629",
      "--blue": "#65a8ff",
      "--orange": "#f5a45d",
      "--danger": "#ef7272",
      "--shadow": "#00000073",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin Mocha",
    description: "Soft lavender on deep mauve",
    colors: ["#11111b", "#1e1e2e", "#cba6f7", "#89b4fa"],
    variables: {
      "--bg": "#11111b", "--sidebar": "#151521", "--surface": "#181825", "--surface-raised": "#1e1e2e", "--surface-hover": "#242438", "--border": "#313244", "--border-strong": "#45475a", "--text": "#cdd6f4", "--text-secondary": "#bac2de", "--text-muted": "#7f849c", "--accent": "#cba6f7", "--accent-soft": "#cba6f72b", "--blue": "#89b4fa", "--orange": "#fab387", "--danger": "#f38ba8", "--shadow": "#09091080",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "Violet and cyan on charcoal",
    colors: ["#191a21", "#282a36", "#bd93f9", "#8be9fd"],
    variables: {
      "--bg": "#191a21", "--sidebar": "#20212b", "--surface": "#242631", "--surface-raised": "#282a36", "--surface-hover": "#303240", "--border": "#3b3e4f", "--border-strong": "#505465", "--text": "#f8f8f2", "--text-secondary": "#d2d2cb", "--text-muted": "#7f8295", "--accent": "#bd93f9", "--accent-soft": "#bd93f92b", "--blue": "#8be9fd", "--orange": "#ffb86c", "--danger": "#ff5555", "--shadow": "#090a0f80",
    },
  },
  {
    id: "nord",
    name: "Nord",
    description: "Arctic blue, quiet and cool",
    colors: ["#242933", "#2e3440", "#88c0d0", "#81a1c1"],
    variables: {
      "--bg": "#242933", "--sidebar": "#292f3b", "--surface": "#2e3440", "--surface-raised": "#343b49", "--surface-hover": "#3b4352", "--border": "#434c5e", "--border-strong": "#596579", "--text": "#eceff4", "--text-secondary": "#d8dee9", "--text-muted": "#7f8b9f", "--accent": "#88c0d0", "--accent-soft": "#88c0d02b", "--blue": "#81a1c1", "--orange": "#d08770", "--danger": "#bf616a", "--shadow": "#11151c80",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    description: "Neon blue on midnight navy",
    colors: ["#16161e", "#1a1b26", "#7aa2f7", "#bb9af7"],
    variables: {
      "--bg": "#12131a", "--sidebar": "#16161e", "--surface": "#1a1b26", "--surface-raised": "#202230", "--surface-hover": "#272a3a", "--border": "#2d3348", "--border-strong": "#41496a", "--text": "#c0caf5", "--text-secondary": "#a9b1d6", "--text-muted": "#646c8a", "--accent": "#7aa2f7", "--accent-soft": "#7aa2f72b", "--blue": "#7dcfff", "--orange": "#ff9e64", "--danger": "#f7768e", "--shadow": "#090a1080",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox Dark",
    description: "Warm amber and forest green",
    colors: ["#1d2021", "#282828", "#d79921", "#83a598"],
    variables: {
      "--bg": "#1d2021", "--sidebar": "#222526", "--surface": "#282828", "--surface-raised": "#32302f", "--surface-hover": "#3c3836", "--border": "#49423d", "--border-strong": "#665c54", "--text": "#ebdbb2", "--text-secondary": "#d5c4a1", "--text-muted": "#928374", "--accent": "#d79921", "--accent-soft": "#d799212b", "--blue": "#83a598", "--orange": "#fe8019", "--danger": "#fb4934", "--shadow": "#100f0e80",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    description: "Balanced purple and syntax blue",
    colors: ["#1b1d23", "#21252b", "#c678dd", "#61afef"],
    variables: {
      "--bg": "#1b1d23", "--sidebar": "#1e2127", "--surface": "#21252b", "--surface-raised": "#282c34", "--surface-hover": "#30353e", "--border": "#353b45", "--border-strong": "#4b5361", "--text": "#abb2bf", "--text-secondary": "#9da5b4", "--text-muted": "#636d7c", "--accent": "#c678dd", "--accent-soft": "#c678dd2b", "--blue": "#61afef", "--orange": "#d19a66", "--danger": "#e06c75", "--shadow": "#0c0d1080",
    },
  },
  {
    id: "solarized",
    name: "Solarized Dark",
    description: "Cyan and gold on deep teal",
    colors: ["#002b36", "#073642", "#2aa198", "#b58900"],
    variables: {
      "--bg": "#00252e", "--sidebar": "#002b36", "--surface": "#073642", "--surface-raised": "#0a3d49", "--surface-hover": "#104651", "--border": "#18505a", "--border-strong": "#2b5d66", "--text": "#eee8d5", "--text-secondary": "#b7b3a3", "--text-muted": "#657b83", "--accent": "#2aa198", "--accent-soft": "#2aa1982b", "--blue": "#268bd2", "--orange": "#b58900", "--danger": "#dc322f", "--shadow": "#00161c80",
    },
  },
];

export function applyTheme(themeId: ThemeId): void {
  const theme = themes.find(({ id }) => id === themeId) ?? themes[0]!;
  document.documentElement.dataset.theme = theme.id;
  for (const [name, value] of Object.entries(theme.variables)) {
    document.documentElement.style.setProperty(name, value);
  }
  document.documentElement.style.colorScheme = "dark";
}

export function themeById(themeId: ThemeId): ThemeDefinition {
  return themes.find(({ id }) => id === themeId) ?? themes[0]!;
}
