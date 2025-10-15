---
sidebar_position: 4
title: Change log
---

The change log is an append-only journal of every mutation that passes through a `JsonDatabase` instance. Enable it by supplying a `changeLog` option when you open the database.

```js
const db = await JsonDatabase.open({
  path: "./data",
  changeLog: { path: "./data/changelog.jsonl" },
});
```

Each entry looks like this:

```json title="log entry"
{
  "seq": 12,
  "type": "update",
  "collection": "orders",
  "primaryKey": "_id",
  "timestamp": "2024-05-10T13:54:02.613Z",
  "updates": [
    {
      "previous": { "_id": "o1", "status": "pending" },
      "next": { "_id": "o1", "status": "complete" }
    }
  ],
  "paths": ["orders", "orders/o1"]
}
```

## Reading the log

```js
const entries = await db.changeLog.read();
const lastSeq = entries[entries.length - 1]?.seq || 0;

// Resume from an offset
const tail = await db.changeLog.read({ from: lastSeq });
```

- Use `seq` to resume CDC consumers after restarts.
- Entries mirror watcher payloads, so ingestion pipelines can share code with real-time listeners.
- Pass `limit` to keep memory usage predictable: `await db.changeLog.read({ limit: 200 })`.
- Call `await db.changeLog.clear()` when you want to truncate the journal.

## Retention & rotation

Long-lived journals can grow quickly. Configure retention to keep only the recent tail and archive the rest:

```js
const db = await JsonDatabase.open({
  path: "./data",
  changeLog: {
    path: "./data/changelog/log.jsonl",
    maxEntries: 10000,
    maxSize: 5 * 1024 * 1024, // 5 MiB
    autoArchive: true,
  },
});
```

- `maxEntries` keeps at most N rows in the active log.
- `maxSize` enforces a byte ceiling (the most recent entries are preserved).
- `autoArchive` writes older entries to `<log>/archive/log-<timestamp>.jsonl` before truncating.

Sequence numbers remain monotonic after rotation, so downstream consumers can resume safely from the last seen `seq`.

## CLI tailing & CDC recipes

Use the CLI for quick inspection or to bootstrap change data capture:

```bash
# Stream the latest 50 events from the default log
jsonvault changelog tail ./data --limit=50

# Resume from a known sequence id and limit the output
jsonvault changelog tail ./data --from=2048 --limit=100

# Override the log path (useful when a custom location is configured)
jsonvault changelog tail ./data --log=/var/log/jsonvault/log.jsonl
```

Combine the CLI with `--config` to avoid repeating adapter and path options in scripts. For longer outages, replay any archived segments (they live under the `archive/` folder beside the log) before tailing the live file.

## Change log vs. `db.watch()`

| Feature | Change log | `db.watch()` |
| ------- | ---------- | ------------- |
| Durability | Yes (persists to disk) | No (in-memory only) |
| Replay | Yes via `read({ from: ... })` | No |
| Use case | CDC connectors, analytics batches | UI live updates, job triggers |

You can combine both: pipe the change log into a message broker for replayability while watchers fan out in-process updates to interested components.
