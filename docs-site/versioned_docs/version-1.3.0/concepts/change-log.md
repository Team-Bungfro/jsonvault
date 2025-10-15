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
- Call `await db.changeLog.clear()` when you want to truncate the journal.

## Change log vs. `db.watch()`

| Feature | Change log | `db.watch()` |
| ------- | ---------- | ------------- |
| Durability | Yes (persists to disk) | No (in-memory only) |
| Replay | Yes via `read({ from: ... })` | No |
| Use case | CDC connectors, analytics batches | UI live updates, job triggers |

You can combine both: pipe the change log into a message broker for replayability while watchers fan out in-process updates to interested components.
