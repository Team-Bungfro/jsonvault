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
| `jsonvault snapshot <path>` | Persist a snapshot file (optionally sign) |
| `jsonvault migrate <path> <action>` | Run migrations (`up`, `down`, `status`, `create`) |
| `jsonvault changelog tail <path>` | Print the recent change log tail (`--limit`, `--from`, `--log`) |

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

# JSON-friendly migration status
jsonvault migrate ./data status --json --dir=./migrations

# Tail the change log
jsonvault changelog tail ./data --limit=50
```

## Global options

- `--adapter=<name>` and `--adapterOptions=<json>` customise storage adapters.
- `--dir=<path>` points migration commands at a specific folder (defaults to `<db>/migrations`).
- `--dryRun` preview migrations without changing data.
- `--config=<file>` loads shared defaults (database path, adapter, change log, migration directory).
- `--json` emits machine-friendly output for `migrate status`.

### Configuration file

Create a `.jsonvault.config.json` to share defaults across commands:

```json
{
  "database": {
    "path": "./data",
    "adapter": "json",
    "changeLog": {
      "path": "./data/changelog/log.jsonl",
      "maxEntries": 50000,
      "autoArchive": true
    }
  },
  "migrations": {
    "directory": "./migrations"
  }
}
```

Invoke commands with `--config=.jsonvault.config.json` and the CLI will reuse those settings:

```bash
jsonvault stats --config=.jsonvault.config.json
jsonvault migrate --config=.jsonvault.config.json status --json
jsonvault changelog tail --config=.jsonvault.config.json --limit=25
```

Flags provided on the command line always override values from the config file.

Add CLI tasks to package.json for convenience:

```json title="package.json"
{
  "scripts": {
    "db:migrate": "jsonvault migrate ./data up --dir=./migrations",
    "db:query": "jsonvault query ./data 'SELECT COUNT(*) AS total FROM orders'"
  }
}
```
