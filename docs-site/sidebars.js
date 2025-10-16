"use strict";

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  guideSidebar: [
    "intro",
    {
      type: "category",
      label: "Getting Started",
      collapsed: false,
      items: [
        "getting-started/installation",
        "getting-started/quickstart",
      ],
    },
    {
      type: "category",
      label: "Concepts",
      items: [
        "concepts/data-model",
        "concepts/queries",
        "concepts/migrations",
        "concepts/change-log",
        "concepts/policies",
      ],
    },
    {
      type: "category",
      label: "How-to Guides",
      items: [
        "guides/hooks",
        "guides/schema",
        "guides/sql",
        "guides/cli",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "reference/configuration",
        "reference/errors",
      ],
    },
  ],
};

module.exports = sidebars;
