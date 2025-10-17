---
sidebar_position: 1
title: Installation
---

## Requirements

- Node.js ≥ 18 (or Bun ≥ 1.0)
- macOS, Linux, or Windows

JSONVault ships as an npm package with zero native dependencies.

## Install with your package manager

```bash npm2yarn
npm install jsonvault
```

```bash
pnpm add jsonvault
```

```bash
bun add jsonvault
```

## Optional peer dependencies

| Capability | Package | Reason |
| ---------- | ------- | ------ |
| YAML adapter | `yaml` | Enables reads/writes in YAML instead of JSON |
| Docs site | `@docusaurus/core`, `@docusaurus/preset-classic` | Only required if you plan to build the documentation locally |

All optional integrations fall back gracefully when the dependency is missing.
