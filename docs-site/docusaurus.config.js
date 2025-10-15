"use strict";

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "JSONVault",
  tagline: "JSON document storage that lives in your repo",
  deploymentBranch: "gh-pages",
  url: "https://team-bungfro.github.io",
  baseUrl: "/",
  favicon: "img/favicon.ico",
  organizationName: "team-bungfro",
  projectName: "jsonvault",
  onBrokenLinks: "warn",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn"
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve("./sidebars.js"),
          editUrl: undefined,
        },
        blog: false,
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: "JSONVault",
        logo: {
          alt: "JSONVault logo",
          src: "img/logo.svg",
        },
        items: [
          {
            type: "docSidebar",
            sidebarId: "guideSidebar",
            position: "left",
            label: "Guides",
          },
          {
            type: "docsVersionDropdown",
            position: "right",
            dropdownActiveClassDisabled: true,
          },
          {
            href: "https://github.com/team-bungfro/jsonvault",
            label: "GitHub",
            position: "right",
          },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [
              {
                label: "Getting Started",
                to: "/docs/getting-started",
              },
              {
                label: "Concepts",
                to: "/docs/concepts/data-model",
              },
            ],
          },
          {
            title: "Community",
            items: [
              {
                label: "GitHub Issues",
                href: "https://github.com/team-bungfro/jsonvault/issues",
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Bungfro.`,
      },
      // prism: {
      //   theme: require("prism-react-renderer/themes/github"),
      //   darkTheme: require("prism-react-renderer/themes/dracula"),
      // },
    }),
};

module.exports = config;
