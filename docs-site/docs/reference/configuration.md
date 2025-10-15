---
sidebar_position: 1
title: Configuration
---

JSONVault exposes configuration at two levels: database options used when you call `JsonDatabase.open()` and runtime options applied per collection. This page catalogs each switch available in 1.3.0.

## Database options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `path` | `string` | `process.cwd()/json-storage` | Directory that stores `meta.json` and `collections/`. |
| `autosave` | `boolean` | `true` | Automatically writes dirty collections after change events. |
| `autosaveInterval` | `number` | `750` | Debounce window (ms) for autosave when enabled. |
| `ttlIntervalMs` | `number` | `60_000` | Frequency of TTL sweeps. Set to `0` to disable the background job. |
| `adapter` | `"json" \| "yaml" \| "memory"` | `"json"` | Storage adapter. Register additional adapters via `registerAdapter()`. |
| `adapterOptions` | `object` | `{}` | Adapter-specific options (e.g. YAML indentation). |
| `storage` | `StorageAdapter` | — | Provide a custom adapter instance instead of `adapter`. |
| `changeLog` | `boolean \| { path?: string; directory?: string }` | `false` | Enables the durable change log. When `true`, a default `log.jsonl` is written beside the data directory. |

```js
const db = await JsonDatabase.open({
  path: "./data",
  ttlIntervalMs: 0, // disable background sweeps
  adapter: "yaml",
  adapterOptions: { indentation: 2 },
  changeLog: { directory: "./data/logs" },
});
```

## Collection runtime options

Pass these when calling `db.collection(name, options)`.

| Option | Type | Description |
| ------ | ---- | ----------- |
| `primaryKey` | `string` | Override `_id` as the identifier. |
| `schema` | `SchemaDefinition \| Schema` | Declarative schema that validates and transforms documents. |
| `validator` | `(doc) => void \| Promise<void>` | Imperative validation hook. Throw to abort. |
| `hooks` | `CollectionHooks` | Lifecycle hooks (`beforeInsert`, `afterUpdate`, etc.). |
| `encryption` | `{ secret: string; fields: string[] }` | Field-level encryption configuration. |
| `partition` | `{ chunkSize: number; key?: string; strategy?: string }` | Chunked storage configuration. |

### Hook payloads

| Hook | Payload |
| ---- | ------- |
| `beforeInsert(doc)` | Mutable document. |
| `afterInsert(doc)` | Immutable snapshot. |
| `beforeUpdate({ previous, next, update })` | Mutable `next`. |
| `afterUpdate({ previous, next })` | Immutable snapshots. |
| `beforeDelete(doc)` | Snapshot before removal. |
| `afterDelete(doc)` | Snapshot after removal. |

## Migration CLI options

| Flag | Description |
| ---- | ----------- |
| `--dir=<path>` | Directory containing migration files. Defaults to `<db>/migrations`. |
| `--to=<id>` | Apply/rollback up to a specific migration ID. |
| `--step=<n>` | Number of migrations to apply or revert. |
| `--dryRun` | Preview without executing. |

## Environment variables

- `JSONVAULT_DATA` – override the database path for CLI commands.
- `JSONVAULT_BENCH_DOCS` – number of documents for the benchmark script.

## TypeScript entry points

Typings live at `types/index.d.ts`. Common imports:

```ts
import {
  JsonDatabase,
  createSchema,
  Filter,
  Schema,
  CollectionRuntimeOptions,
} from "jsonvault";
```

Need more detail? Open an issue at [github.com/team-bungfro/jsonvault](https://github.com/team-bungfro/jsonvault/issues).
