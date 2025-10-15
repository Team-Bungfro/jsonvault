---
sidebar_position: 4
title: CLI guide
---

The `JSONVault` CLI gives you quick access to stats, queries, migrations, and snapshots. Install it via `npx` or add it to your project scripts.

## Common commands

| Command | Description |
| ------- | ----------- |
| `jsonvault list <path>` | List collections under `collections/` |
| `jsonvault stats <path>` | Summary of collection counts and indexes |
| `jsonvault dump <path> <collection>` | Print documents (use `--limit`, `--filter`) |
| `jsonvault export <path> <collection>` | Export as JSON or CSV |
| `jsonvault query <path> <sql>` | Execute SQL/JSONPath and print JSON |
| `JSONVault snapshot <path>` | Persist a snapshot file (optionally sign) |
| `jsonvault migrate <path> <action>` | Run migrations (`up`, `down`, `status`, `create`) |

### Examples

```bash
# Dump active orders
npx jsonvault dump ./data orders --filter='{"status":"active"}' --limit=5

# Export to CSV
npx jsonvault export ./data users --format=csv --out=/tmp/users.csv

# Create & run a migration
npx jsonvault migrate ./data create add-status --dir=./migrations
npx jsonvault migrate ./data up --dir=./migrations

# SQL query
npx jsonvault query ./data "SELECT userId, SUM(total) AS spend FROM orders GROUP BY userId"
```

## Global options

- `--adapter=<name>` and `--adapterOptions=<json>` customise storage adapters.
- `--dir=<path>` points migration commands at a specific folder (defaults to `<db>/migrations`).
- `--dryRun` preview migrations without changing data.

Add CLI tasks to package.json for convenience:

```json title="package.json"
{
  "scripts": {
    "db:migrate": "jsonvault migrate ./data up --dir=./migrations",
    "db:query": "jsonvault query ./data 'SELECT COUNT(*) AS total FROM orders'"
  }
}
```
