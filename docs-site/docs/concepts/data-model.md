---
sidebar_position: 1
title: Data model
---

JSONVault organises content into **collections**. Each collection serialises to a JSON file (or a set of chunked JSON files when partitioning is enabled).

## Collections

- Created lazily on first access: `db.collection("users")`.
- Primary key defaults to `_id`. Provide `primaryKey` when you need something else.
- Supports `insertOne`, `insertMany`, `find`, `findOne`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `count`, `distinct`, `countBy`, `at`, and `ensureIndex`.

```js
const users = db.collection("users", { primaryKey: "id" });
await users.insertOne({ id: "u1", name: "Ada" });
const ada = await users.findOne({ name: "Ada" });
```

## Documents

- Plain objects with nested fields, arrays, and primitives.
- JSONVault stores a clone of your document, keeping the original object untouched.
- Hooks and schemas let you mutate documents before they persist.

## Indexes

| Type | How | Notes |
| ---- | --- | ----- |
| Unique | `ensureIndex("email", { unique: true })` | Rejects duplicates at write time |
| Secondary | `ensureIndex("status")` | Speeds up equality searches |
| TTL | `ensureIndex("createdAt", { ttlSeconds: 3600 })` | Automatically removes expired docs |

## Partitions

Split large collections into chunk files for better I/O characteristics.

```js
const logs = db.collection("logs", {
  partition: { chunkSize: 10_000, key: "timestamp" },
});
```

- `chunkSize` controls the number of documents per chunk.
- `key` enables range-aware scanning (e.g. ISO timestamp, epoch number).
- `collection.explain(filter)` reveals which chunks a query would scan.

## Encryption

Enable per-field symmetric encryption to protect secrets at rest.

```js
const secrets = db.collection("secrets", {
  encryption: {
    secret: process.env.JSONVAULT_SECRET,
    fields: ["password", "token.refresh"],
  },
});
```

- Encrypted fields remain queryable (values decrypted transparently in memory).
- The key never lands on disk—supply it when you reopen the database.
