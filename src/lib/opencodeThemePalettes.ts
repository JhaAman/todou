type HexColor = `#${string}`;

export const OPEN_CODE_THEME_FAMILY_IDS = [
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
  "zenburn"
] as const;

export type OpenCodeThemeFamilyId = (typeof OPEN_CODE_THEME_FAMILY_IDS)[number];
export type OpenCodeThemeMode = "light" | "dark";

export interface OpenCodeThemePalette {
  readonly neutral: HexColor;
  readonly ink: HexColor;
  readonly primary: HexColor;
  readonly accent?: HexColor;
  readonly interactive?: HexColor;
  readonly info: HexColor;
  readonly warning: HexColor;
  readonly error: HexColor;
}

interface OpenCodeThemeFamily {
  readonly name: string;
  readonly light: OpenCodeThemePalette;
  readonly dark: OpenCodeThemePalette;
}

// Pinned to OpenCode 4438f69aac46806c631866489a26b644488a784e; its runtime-only system theme has no fixed palette.
export const openCodeThemePalettes = {
  "oc-2": {
    name: "OC-2",
    light: { neutral: "#f7f7f7", ink: "#171311", primary: "#dcde8d", interactive: "#034cff", info: "#a753ae", warning: "#ffdc17", error: "#fc533a" },
    dark: { neutral: "#1f1f1f", ink: "#f1ece8", primary: "#fab283", interactive: "#034cff", info: "#edb2f1", warning: "#fcd53a", error: "#fc533a" },
  },
  "amoled": {
    name: "AMOLED",
    light: { neutral: "#f0f0f0", ink: "#0a0a0a", primary: "#6200ff", accent: "#ff0080", info: "#00b0ff", warning: "#ffab00", error: "#ff1744" },
    dark: { neutral: "#000000", ink: "#ffffff", primary: "#b388ff", accent: "#ff4081", info: "#18ffff", warning: "#ffea00", error: "#ff1744" },
  },
  "aura": {
    name: "Aura",
    light: { neutral: "#f5f0ff", ink: "#2d2640", primary: "#a277ff", accent: "#d94f4f", info: "#5bb8d9", warning: "#d9a24a", error: "#d94f4f" },
    dark: { neutral: "#15141b", ink: "#edecee", primary: "#a277ff", accent: "#ff6767", info: "#82e2ff", warning: "#ffca85", error: "#ff6767" },
  },
  "ayu": {
    name: "Ayu",
    light: { neutral: "#fdfaf4", ink: "#4f5964", primary: "#4aa8c8", accent: "#ef7d71", info: "#2f9bce", warning: "#ea9f41", error: "#e6656a" },
    dark: { neutral: "#0f1419", ink: "#d6dae0", primary: "#3fb7e3", accent: "#f2856f", info: "#66c6f1", warning: "#e4a75c", error: "#f58572" },
  },
  "carbonfox": {
    name: "Carbonfox",
    light: { neutral: "#8e8e8e", ink: "#161616", primary: "#0072c3", accent: "#da1e28", interactive: "#0f62fe", info: "#0043ce", warning: "#f1c21b", error: "#da1e28" },
    dark: { neutral: "#393939", ink: "#f2f4f8", primary: "#33b1ff", accent: "#ff8389", interactive: "#4589ff", info: "#78a9ff", warning: "#f1c21b", error: "#ff8389" },
  },
  "catppuccin": {
    name: "Catppuccin",
    light: { neutral: "#f5e0dc", ink: "#4c4f69", primary: "#7287fd", accent: "#d20f39", info: "#04a5e5", warning: "#df8e1d", error: "#d20f39" },
    dark: { neutral: "#1e1e2e", ink: "#cdd6f4", primary: "#b4befe", accent: "#f38ba8", info: "#89dceb", warning: "#f4b8e4", error: "#f38ba8" },
  },
  "catppuccin-frappe": {
    name: "Catppuccin Frappe",
    light: { neutral: "#303446", ink: "#c6d0f5", primary: "#8da4e2", accent: "#f4b8e4", info: "#81c8be", warning: "#e5c890", error: "#e78284" },
    dark: { neutral: "#303446", ink: "#c6d0f5", primary: "#8da4e2", accent: "#f4b8e4", info: "#81c8be", warning: "#e5c890", error: "#e78284" },
  },
  "catppuccin-macchiato": {
    name: "Catppuccin Macchiato",
    light: { neutral: "#24273a", ink: "#cad3f5", primary: "#8aadf4", accent: "#f5bde6", info: "#8bd5ca", warning: "#eed49f", error: "#ed8796" },
    dark: { neutral: "#24273a", ink: "#cad3f5", primary: "#8aadf4", accent: "#f5bde6", info: "#8bd5ca", warning: "#eed49f", error: "#ed8796" },
  },
  "cobalt2": {
    name: "Cobalt2",
    light: { neutral: "#ffffff", ink: "#193549", primary: "#0066cc", accent: "#00acc1", info: "#ff5722", warning: "#ff9800", error: "#e91e63" },
    dark: { neutral: "#193549", ink: "#ffffff", primary: "#0088ff", accent: "#2affdf", info: "#ff9d00", warning: "#ffc600", error: "#ff0088" },
  },
  "cursor": {
    name: "Cursor",
    light: { neutral: "#fcfcfc", ink: "#141414", primary: "#6f9ba6", accent: "#6f9ba6", interactive: "#206595", info: "#3c7cab", warning: "#db704b", error: "#cf2d56" },
    dark: { neutral: "#181818", ink: "#e4e4e4", primary: "#88c0d0", accent: "#88c0d0", interactive: "#82D2CE", info: "#81a1c1", warning: "#f1b467", error: "#e34671" },
  },
  "dracula": {
    name: "Dracula",
    light: { neutral: "#f8f8f2", ink: "#1f1f2f", primary: "#7c6bf5", accent: "#d16090", info: "#1d7fc5", warning: "#f7a14d", error: "#d9536f" },
    dark: { neutral: "#1d1e28", ink: "#f8f8f2", primary: "#bd93f9", accent: "#ff79c6", info: "#8be9fd", warning: "#ffb86c", error: "#ff5555" },
  },
  "everforest": {
    name: "Everforest",
    light: { neutral: "#fdf6e3", ink: "#5c6a72", primary: "#8da101", accent: "#df69ba", info: "#35a77c", warning: "#f57d26", error: "#f85552" },
    dark: { neutral: "#2d353b", ink: "#d3c6aa", primary: "#a7c080", accent: "#d699b6", info: "#83c092", warning: "#e69875", error: "#e67e80" },
  },
  "flexoki": {
    name: "Flexoki",
    light: { neutral: "#FFFCF0", ink: "#100F0F", primary: "#205EA6", accent: "#BC5215", info: "#24837B", warning: "#BC5215", error: "#AF3029" },
    dark: { neutral: "#100F0F", ink: "#CECDC3", primary: "#DA702C", accent: "#8B7EC8", interactive: "#4385BE", info: "#3AA99F", warning: "#DA702C", error: "#D14D41" },
  },
  "github": {
    name: "GitHub",
    light: { neutral: "#ffffff", ink: "#24292f", primary: "#0969da", accent: "#1b7c83", info: "#bc4c00", warning: "#9a6700", error: "#cf222e" },
    dark: { neutral: "#0d1117", ink: "#c9d1d9", primary: "#58a6ff", accent: "#39c5cf", info: "#d29922", warning: "#e3b341", error: "#f85149" },
  },
  "gruvbox": {
    name: "Gruvbox",
    light: { neutral: "#fbf1c7", ink: "#3c3836", primary: "#076678", accent: "#9d0006", info: "#8f3f71", warning: "#b57614", error: "#9d0006" },
    dark: { neutral: "#282828", ink: "#ebdbb2", primary: "#83a598", accent: "#fb4934", info: "#d3869b", warning: "#fabd2f", error: "#fb4934" },
  },
  "kanagawa": {
    name: "Kanagawa",
    light: { neutral: "#F2E9DE", ink: "#54433A", primary: "#2D4F67", accent: "#D27E99", info: "#76946A", warning: "#D7A657", error: "#E82424" },
    dark: { neutral: "#1F1F28", ink: "#DCD7BA", primary: "#7E9CD8", accent: "#D27E99", info: "#76946A", warning: "#D7A657", error: "#E82424" },
  },
  "lucent-orng": {
    name: "Lucent Orng",
    light: { neutral: "#fff5f0", ink: "#1a1a1a", primary: "#EC5B2B", accent: "#c94d24", info: "#318795", warning: "#EC5B2B", error: "#d1383d" },
    dark: { neutral: "#2a1a15", ink: "#eeeeee", primary: "#EC5B2B", accent: "#FFF7F1", info: "#56b6c2", warning: "#EC5B2B", error: "#e06c75" },
  },
  "material": {
    name: "Material",
    light: { neutral: "#fafafa", ink: "#263238", primary: "#6182b8", accent: "#39adb5", interactive: "#39adb5", info: "#f4511e", warning: "#ffb300", error: "#e53935" },
    dark: { neutral: "#263238", ink: "#eeffff", primary: "#82aaff", accent: "#89ddff", interactive: "#89ddff", info: "#ffcb6b", warning: "#ffcb6b", error: "#f07178" },
  },
  "matrix": {
    name: "Matrix",
    light: { neutral: "#eef3ea", ink: "#203022", primary: "#1cc24b", accent: "#c770ff", interactive: "#30b3ff", info: "#30b3ff", warning: "#e6ff57", error: "#ff4b4b" },
    dark: { neutral: "#0a0e0a", ink: "#62ff94", primary: "#2eff6a", accent: "#c770ff", interactive: "#30b3ff", info: "#30b3ff", warning: "#e6ff57", error: "#ff4b4b" },
  },
  "mercury": {
    name: "Mercury",
    light: { neutral: "#ffffff", ink: "#363644", primary: "#5266eb", accent: "#8da4f5", interactive: "#465bd1", info: "#007f95", warning: "#a44200", error: "#b0175f" },
    dark: { neutral: "#171721", ink: "#dddde5", primary: "#8da4f5", accent: "#8da4f5", info: "#77becf", warning: "#fc9b6f", error: "#fc92b4" },
  },
  "monokai": {
    name: "Monokai",
    light: { neutral: "#fdf8ec", ink: "#292318", primary: "#bf7bff", accent: "#d9487c", info: "#2d9ad7", warning: "#f1a948", error: "#e54b4b" },
    dark: { neutral: "#272822", ink: "#f8f8f2", primary: "#ae81ff", accent: "#f92672", info: "#66d9ef", warning: "#fd971f", error: "#f92672" },
  },
  "nightowl": {
    name: "Night Owl",
    light: { neutral: "#f0f0f0", ink: "#403f53", primary: "#4876d6", accent: "#aa0982", info: "#4876d6", warning: "#c96765", error: "#de3d3b" },
    dark: { neutral: "#011627", ink: "#d6deeb", primary: "#82aaff", accent: "#f78c6c", info: "#82aaff", warning: "#ecc48d", error: "#ef5350" },
  },
  "nord": {
    name: "Nord",
    light: { neutral: "#eceff4", ink: "#2e3440", primary: "#5e81ac", accent: "#bf616a", info: "#81a1c1", warning: "#d08770", error: "#bf616a" },
    dark: { neutral: "#2e3440", ink: "#e5e9f0", primary: "#88c0d0", accent: "#d57780", info: "#81a1c1", warning: "#d08770", error: "#bf616a" },
  },
  "one-dark": {
    name: "One Dark",
    light: { neutral: "#fafafa", ink: "#383a42", primary: "#4078f2", accent: "#0184bc", info: "#986801", warning: "#c18401", error: "#e45649" },
    dark: { neutral: "#282c34", ink: "#abb2bf", primary: "#61afef", accent: "#56b6c2", info: "#d19a66", warning: "#e5c07b", error: "#e06c75" },
  },
  "onedarkpro": {
    name: "One Dark Pro",
    light: { neutral: "#f5f6f8", ink: "#2b303b", primary: "#528bff", accent: "#d85462", info: "#61afef", warning: "#d19a66", error: "#e06c75" },
    dark: { neutral: "#1e222a", ink: "#abb2bf", primary: "#61afef", accent: "#e06c75", info: "#56b6c2", warning: "#e5c07b", error: "#e06c75" },
  },
  "opencode": {
    name: "OpenCode",
    light: { neutral: "#ffffff", ink: "#1a1a1a", primary: "#3b7dd8", accent: "#d68c27", info: "#318795", warning: "#d68c27", error: "#d1383d" },
    dark: { neutral: "#0a0a0a", ink: "#eeeeee", primary: "#fab283", accent: "#9d7cd8", info: "#56b6c2", warning: "#f5a742", error: "#e06c75" },
  },
  "orng": {
    name: "Orng",
    light: { neutral: "#ffffff", ink: "#1a1a1a", primary: "#EC5B2B", accent: "#c94d24", info: "#318795", warning: "#EC5B2B", error: "#d1383d" },
    dark: { neutral: "#0a0a0a", ink: "#eeeeee", primary: "#EC5B2B", accent: "#FFF7F1", info: "#56b6c2", warning: "#EC5B2B", error: "#e06c75" },
  },
  "osaka-jade": {
    name: "Osaka Jade",
    light: { neutral: "#F6F5DD", ink: "#111c18", primary: "#1faa90", accent: "#3d7a52", info: "#1faa90", warning: "#b5a020", error: "#c7392d" },
    dark: { neutral: "#111c18", ink: "#C1C497", primary: "#2DD5B7", accent: "#549e6a", interactive: "#8CD3CB", info: "#2DD5B7", warning: "#E5C736", error: "#FF5345" },
  },
  "palenight": {
    name: "Palenight",
    light: { neutral: "#fafafa", ink: "#292d3e", primary: "#4976eb", accent: "#00acc1", info: "#f4511e", warning: "#ffb300", error: "#e53935" },
    dark: { neutral: "#292d3e", ink: "#a6accd", primary: "#82aaff", accent: "#89ddff", info: "#f78c6c", warning: "#ffcb6b", error: "#f07178" },
  },
  "rosepine": {
    name: "Rose Pine",
    light: { neutral: "#faf4ed", ink: "#575279", primary: "#31748f", accent: "#d7827e", info: "#56949f", warning: "#ea9d34", error: "#b4637a" },
    dark: { neutral: "#191724", ink: "#e0def4", primary: "#9ccfd8", accent: "#ebbcba", info: "#9ccfd8", warning: "#f6c177", error: "#eb6f92" },
  },
  "shadesofpurple": {
    name: "Shades of Purple",
    light: { neutral: "#f7ebff", ink: "#3b2c59", primary: "#7a5af8", accent: "#ff6bd5", info: "#62d4ff", warning: "#f7c948", error: "#ff6bd5" },
    dark: { neutral: "#1a102b", ink: "#f5f0ff", primary: "#c792ff", accent: "#ff7ac6", info: "#7dd4ff", warning: "#ffd580", error: "#ff7ac6" },
  },
  "solarized": {
    name: "Solarized",
    light: { neutral: "#fdf6e3", ink: "#586e75", primary: "#268bd2", accent: "#d33682", info: "#2aa198", warning: "#b58900", error: "#dc322f" },
    dark: { neutral: "#002b36", ink: "#93a1a1", primary: "#6c71c4", accent: "#d33682", info: "#2aa198", warning: "#b58900", error: "#dc322f" },
  },
  "synthwave84": {
    name: "Synthwave '84",
    light: { neutral: "#fafafa", ink: "#262335", primary: "#00bcd4", accent: "#9c27b0", info: "#ff5722", warning: "#ff9800", error: "#f44336" },
    dark: { neutral: "#262335", ink: "#ffffff", primary: "#36f9f6", accent: "#b084eb", info: "#ff8b39", warning: "#fede5d", error: "#fe4450" },
  },
  "tokyonight": {
    name: "Tokyonight",
    light: { neutral: "#e1e2e7", ink: "#273153", primary: "#2e7de9", accent: "#b15c00", info: "#007197", warning: "#8c6c3e", error: "#c94060" },
    dark: { neutral: "#1a1b26", ink: "#c0caf5", primary: "#7aa2f7", accent: "#ff9e64", info: "#7dcfff", warning: "#e0af68", error: "#f7768e" },
  },
  "vercel": {
    name: "Vercel",
    light: { neutral: "#FFFFFF", ink: "#171717", primary: "#0070F3", accent: "#8E4EC6", info: "#0070F3", warning: "#FF9500", error: "#DC3545" },
    dark: { neutral: "#000000", ink: "#EDEDED", primary: "#0070F3", accent: "#8E4EC6", interactive: "#52A8FF", info: "#52A8FF", warning: "#FFB224", error: "#E5484D" },
  },
  "vesper": {
    name: "Vesper",
    light: { neutral: "#F0F0F0", ink: "#101010", primary: "#FFC799", accent: "#B30000", info: "#FFC799", warning: "#FFC799", error: "#FF8080" },
    dark: { neutral: "#101010", ink: "#FFF", primary: "#FFC799", accent: "#FF8080", info: "#FFC799", warning: "#FFC799", error: "#FF8080" },
  },
  "zenburn": {
    name: "Zenburn",
    light: { neutral: "#ffffef", ink: "#3f3f3f", primary: "#5f7f8f", accent: "#5f8f8f", info: "#8f7f5f", warning: "#8f8f5f", error: "#8f5f5f" },
    dark: { neutral: "#3f3f3f", ink: "#dcdccc", primary: "#8cd0d3", accent: "#93e0e3", info: "#dfaf8f", warning: "#f0dfaf", error: "#cc9393" },
  },
} as const satisfies Record<OpenCodeThemeFamilyId, OpenCodeThemeFamily>;

