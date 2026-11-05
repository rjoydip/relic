import { themeToTreeStyles, type FileTreeIconConfig } from "@pierre/trees";
import type { CSSProperties } from "react";

type ThemeMode = "dark" | "light";

export const TREE_ICONS: FileTreeIconConfig = {
  set: "complete",
  colored: true,
};

// VS Code workbench keys the trees theme pipeline reads (trees.software/
// #theming) — values mirror the CSS tokens in style.css so tree, sidebar,
// dashboard and graph stay one palette per mode
const PALETTES: Record<ThemeMode, { bg: string; fg: string; colors: Record<string, string> }> = {
  dark: {
    bg: "#181420",
    fg: "#f5f2f7",
    colors: {
      "sideBar.background": "#181420",
      "sideBar.foreground": "#f5f2f7",
      "sideBar.border": "#2a2333",
      "sideBarSectionHeader.foreground": "#b4a9bf",
      "list.activeSelectionBackground": "#2a1f36",
      "list.activeSelectionForeground": "#f5f2f7",
      "list.focusBackground": "#221a2b",
      "list.focusOutline": "#c73f92",
      "list.hoverBackground": "#221a2b",
      "input.background": "#221a2b",
      "input.foreground": "#f5f2f7",
      "input.border": "#3b2f47",
      focusBorder: "#c73f92",
      "scrollbarSlider.background": "#3b2f47",
      "gitDecoration.addedResourceForeground": "#4ade80",
      "gitDecoration.modifiedResourceForeground": "#f0b429",
      "gitDecoration.deletedResourceForeground": "#f05252",
    },
  },
  light: {
    bg: "#f6f2f9",
    fg: "#1c1420",
    colors: {
      "sideBar.background": "#f6f2f9",
      "sideBar.foreground": "#1c1420",
      "sideBar.border": "#e6ddeb",
      "sideBarSectionHeader.foreground": "#5c4f66",
      "list.activeSelectionBackground": "#ece4f2",
      "list.activeSelectionForeground": "#1c1420",
      "list.focusBackground": "#ece4f2",
      "list.focusOutline": "#a03370",
      "list.hoverBackground": "#ece4f2",
      "input.background": "#ffffff",
      "input.foreground": "#1c1420",
      "input.border": "#d4c7de",
      focusBorder: "#a03370",
      "scrollbarSlider.background": "#d4c7de",
      "gitDecoration.addedResourceForeground": "#15803d",
      "gitDecoration.modifiedResourceForeground": "#a16207",
      "gitDecoration.deletedResourceForeground": "#dc2626",
    },
  },
};

export function treeThemeStyles(theme: ThemeMode): CSSProperties {
  const palette = PALETTES[theme];
  const accent = theme === "dark" ? "#c73f92" : "#a03370";
  const derived = themeToTreeStyles({
    type: theme,
    bg: palette.bg,
    fg: palette.fg,
    colors: palette.colors,
  }) as Record<string, string>;
  // host sizing stays owned by .graph-tree in style.css
  delete derived.flex;
  delete derived.height;
  delete derived.minHeight;
  return {
    ...derived,
    // documented override layer: selection and focus follow the brand magenta
    "--trees-accent-override": accent,
    "--trees-theme-list-active-selection-bg": `color-mix(in oklab, ${accent} 20%, transparent)`,
    "--trees-theme-focus-ring": accent,
  } as CSSProperties;
}
