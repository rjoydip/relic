import { themeToTreeStyles, type FileTreeIconConfig } from "@pierre/trees";
import type { CSSProperties } from "react";

type ThemeMode = "dark" | "light";

// Custom icons per trees.software/#custom-icons: the complete colored set,
// extended with a project sprite — the generic-file slot becomes a "symbol"
// glyph (braces), so extensionless leaves (our symbols) read apart from
// real files. currentColor inherits the tree's themed foreground.
const SYMBOL_SPRITE =
  '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="mcpdg-symbol" viewBox="0 0 16 16"><path d="M6.5 3.5c-1.4 0-1.2 1.7-1.2 2.6 0 .8-.5 1.2-.9 1.9-.4.7-.8 1.1-.8 1.9 0 .9-.2 2.6 1.2 2.6M9.5 3.5c1.4 0 1.2 1.7 1.2 2.6 0 .8.5 1.2.9 1.9.4.7.8 1.1.8 1.9 0 .9.2 2.6-1.2 2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol></svg>';

export const TREE_ICONS: FileTreeIconConfig = {
  set: "complete",
  colored: true,
  spriteSheet: SYMBOL_SPRITE,
  remap: { file: { name: "mcpdg-symbol" } },
};

// VS Code workbench keys the trees theme pipeline reads (trees.software/
// #theming) — values mirror the CSS tokens in style.css so tree, sidebar,
// dashboard and graph stay one palette per mode
const PALETTES: Record<ThemeMode, { bg: string; fg: string; colors: Record<string, string> }> = {
  dark: {
    bg: "#0d1117",
    fg: "#e8eef7",
    colors: {
      "sideBar.background": "#0d1117",
      "sideBar.foreground": "#e8eef7",
      "sideBar.border": "#1d2530",
      "sideBarSectionHeader.foreground": "#93a1b5",
      "list.activeSelectionBackground": "#182031",
      "list.activeSelectionForeground": "#e8eef7",
      "list.focusBackground": "#131922",
      "list.focusOutline": "#5e8bff",
      "list.hoverBackground": "#131922",
      "input.background": "#131922",
      "input.foreground": "#e8eef7",
      "input.border": "#273141",
      focusBorder: "#5e8bff",
      "scrollbarSlider.background": "#273141",
      "gitDecoration.addedResourceForeground": "#3fb950",
      "gitDecoration.modifiedResourceForeground": "#f0b429",
      "gitDecoration.deletedResourceForeground": "#f47067",
    },
  },
  light: {
    bg: "#ffffff",
    fg: "#1b2432",
    colors: {
      "sideBar.background": "#ffffff",
      "sideBar.foreground": "#1b2432",
      "sideBar.border": "#d9dfe9",
      "sideBarSectionHeader.foreground": "#55637a",
      "list.activeSelectionBackground": "#eaf1ff",
      "list.activeSelectionForeground": "#1b2432",
      "list.focusBackground": "#eef1f7",
      "list.focusOutline": "#5e8bff",
      "list.hoverBackground": "#eef1f7",
      "input.background": "#eef1f7",
      "input.foreground": "#1b2432",
      "input.border": "#c6cedd",
      focusBorder: "#5e8bff",
      "scrollbarSlider.background": "#c6cedd",
      "gitDecoration.addedResourceForeground": "#1a8f42",
      "gitDecoration.modifiedResourceForeground": "#b45309",
      "gitDecoration.deletedResourceForeground": "#d64545",
    },
  },
};

export function treeThemeStyles(theme: ThemeMode, accent: string): CSSProperties {
  const palette = PALETTES[theme];
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
    // documented override layer: selection and focus track the live accent
    "--trees-accent-override": accent,
    "--trees-theme-list-active-selection-bg": `color-mix(in oklab, ${accent} 24%, transparent)`,
    "--trees-theme-focus-ring": accent,
  } as CSSProperties;
}
