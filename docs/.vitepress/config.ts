import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Relic",
  description: "Static dependency-graph engine for TypeScript repositories",
  cleanUrls: true,
  appearance: true,
  themeConfig: {
    darkModeSwitchLabel: "Appearance",
    lightModeSwitchTitle: "Switch to light theme",
    darkModeSwitchTitle: "Switch to dark theme",
    sidebar: [
      { text: "Overview", link: "/#what-relic-is" },
      { text: "Requirements", link: "/#requirements" },
      { text: "Install from source", link: "/#install-from-source" },
      { text: "MCP server", link: "/#mcp-server" },
      { text: "CLI", link: "/#cli" },
      { text: "HTTP API", link: "/#http-api" },
      { text: "Dashboard", link: "/#dashboard" },
      { text: "Graph model", link: "/#graph-model" },
      { text: "Indexing semantics", link: "/#indexing-semantics" },
      { text: "Security & limits", link: "/#security-limits" },
      { text: "Repository layout", link: "/#repository-layout" },
      { text: "Development", link: "/#development" },
      { text: "License", link: "/#license" },
    ],
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/rjoydip/relic" }],
    editLink: {
      pattern: "https://github.com/rjoydip/relic/edit/main/docs/index.md",
      text: "Edit this page",
    },
    footer: {
      message: "Local-first · no data leaves your machine",
      copyright: "Relic",
    },
  },
});
