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
    bg: "#141821",
    fg: "#f3f6fb",
    colors: {
      "sideBar.background": "#141821",
      "sideBar.foreground": "#f3f6fb",
      "sideBar.border": "#232b3a",
      "sideBarSectionHeader.foreground": "#aab4c4",
      "list.activeSelectionBackground": "#1b2230",
      "list.activeSelectionForeground": "#f3f6fb",
      "list.focusBackground": "#1b2230",
      "list.focusOutline": "#4f8cff",
      "list.hoverBackground": "#1b2230",
      "input.background": "#1b2230",
      "input.foreground": "#f3f6fb",
      "input.border": "#324056",
      focusBorder: "#4f8cff",
      "scrollbarSlider.background": "#324056",
      "gitDecoration.addedResourceForeground": "#4ade80",
      "gitDecoration.modifiedResourceForeground": "#f0b429",
      "gitDecoration.deletedResourceForeground": "#f05252",
    },
  },
  light: {
    bg: "#f3f6fb",
    fg: "#141a23",
    colors: {
      "sideBar.background": "#f3f6fb",
      "sideBar.foreground": "#141a23",
      "sideBar.border": "#dde4ee",
      "sideBarSectionHeader.foreground": "#536071",
      "list.activeSelectionBackground": "#e8eef7",
      "list.activeSelectionForeground": "#141a23",
      "list.focusBackground": "#e8eef7",
      "list.focusOutline": "#2563eb",
      "list.hoverBackground": "#e8eef7",
      "input.background": "#ffffff",
      "input.foreground": "#141a23",
      "input.border": "#c9d4e4",
      focusBorder: "#2563eb",
      "scrollbarSlider.background": "#c9d4e4",
      "gitDecoration.addedResourceForeground": "#15803d",
      "gitDecoration.modifiedResourceForeground": "#a16207",
      "gitDecoration.deletedResourceForeground": "#dc2626",
    },
  },
};

export function treeThemeStyles(theme: ThemeMode): CSSProperties {
  const palette = PALETTES[theme];
  const accent = theme === "dark" ? "#4f8cff" : "#2563eb";
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
    // documented override layer: selection and focus follow the blue accent
    "--trees-accent-override": accent,
    "--trees-theme-list-active-selection-bg": `color-mix(in oklab, ${accent} 20%, transparent)`,
    "--trees-theme-focus-ring": accent,
  } as CSSProperties;
}
