import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const repo = "https://github.com/superintelligenceco/agent-auth";

export default withMermaid(
  defineConfig({
    title: "agent-auth",
    description:
      "Scoped, expiring, auditable credentials for AI agents that act on a user's behalf.",
    base: "/agent-auth/",
    cleanUrls: true,
    lastUpdated: true,
    head: [["meta", { name: "theme-color", content: "#3c8772" }]],
    themeConfig: {
      nav: [
        { text: "Quickstart", link: "/quickstart" },
        { text: "Concepts", link: "/concepts" },
        { text: "Reference", link: "/reference/cli" },
        { text: "Releases", link: `${repo}/releases` },
      ],
      sidebar: [
        {
          text: "Guide",
          items: [
            { text: "Overview", link: "/" },
            { text: "Quickstart", link: "/quickstart" },
            { text: "Concepts", link: "/concepts" },
            { text: "Use it from a tool server", link: "/tool-servers" },
            { text: "Architecture", link: "/architecture" },
            { text: "FAQ", link: "/faq" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "CLI", link: "/reference/cli" },
            { text: "REST API", link: "/reference/api" },
            { text: "Configuration", link: "/reference/configuration" },
          ],
        },
        {
          text: "Decisions",
          items: [
            { text: "About the ADRs", link: "/adr/" },
            {
              text: "1. Ed25519 JWTs backed by server state",
              link: "/adr/0001-signed-tokens-with-server-state",
            },
            {
              text: "2. Hash-chained audit log in SQLite",
              link: "/adr/0002-hash-chained-audit-log",
            },
            {
              text: "3. Conservative scope attenuation",
              link: "/adr/0003-conservative-attenuation",
            },
            {
              text: "4. Bun executables and tag-driven releases",
              link: "/adr/0004-bun-executables-and-tag-releases",
            },
          ],
        },
      ],
      socialLinks: [{ icon: "github", link: repo }],
      editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
      search: { provider: "local" },
      footer: { message: "Released under the Apache-2.0 license." },
    },
  }),
);
