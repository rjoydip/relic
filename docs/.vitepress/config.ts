import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Relic",
  description: "Relic technical architecture & reference manual",
  cleanUrls: true,
  themeConfig: {
    nav: [{ text: "Documentation", link: "/" }],
    sidebar: [
      {
        text: "Manual",
        items: [
          { text: "Overview", link: "/#overview" },
          { text: "Architecture", link: "/#key-features-architecture" },
          { text: "Getting started", link: "/#installation-getting-started" },
          { text: "API reference", link: "/#api-reference" },
          { text: "Configuration", link: "/#configuration-schema" },
          { text: "Contributing", link: "/#contributing-licensing" },
        ],
      },
    ],
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/rjoydip/relic" }],
    editLink: {
      pattern: "https://github.com/rjoydip/relic/edit/main/docs/index.md",
      text: "Edit this page",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © Relic contributors",
    },
  },
});
