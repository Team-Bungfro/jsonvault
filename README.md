# jsonvault

> JSON-native document storage for Node and Bun, with streaming queries, field-level crypto, and a lightweight footprint.

[![npm version](https://img.shields.io/npm/v/jsonvault.svg?style=flat)](https://www.npmjs.com/package/jsonvault)
[![Node](https://img.shields.io/badge/node->=18-brightgreen.svg?style=flat)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/jsonvault.svg?style=flat)](LICENSE)
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/G2G21MUP3D)

---

## Highlights

- ⚡️ **Instant setup** – drop in a folder path, get a document store with SQL, filters, and streaming cursors.
- 🔐 **Security baked in** – field-level encryption, row policies, and typed errors keep data guarded end-to-end.
- 🧰 **Friendly tooling** – rich CLI, migration scaffolds, and TypeScript definitions make automation effortless.
- 🚀 **Zero server** – all features run inside your process; perfect for CLIs, edge runtimes, and local-first apps.

## Quick Links

- 📚 [Full documentation](https://team-bungfro.github.io/jsonvault)
- 🧪 [Examples folder](examples) &nbsp; • &nbsp; [Benchmarks](benchmarks)
- 💡 [Policies guide](docs-site/docs/concepts/policies.mdx) &nbsp; • &nbsp; [Error reference](docs-site/docs/reference/errors.mdx)
- 🛠️ `npx jsonvault migrate ./data up --dir=./migrations`

---

## Table of Contents

1. [Highlights](#highlights)
2. [Quick Links](#quick-links)
3. [Why jsonvault](#why-jsonvault)
4. [Install](#install)
5. [Hello jsonvault](#hello-jsonvault)
6. [Core Capabilities](#core-capabilities)
7. [Data Access](#data-access)
8. [Data Integrity](#data-integrity)
9. [Storage & Scale](#storage--scale)
10. [Policies & Access Control](#policies--access-control)
11. [Error Handling](#error-handling)
12. [Tooling & Automation](#tooling--automation)
13. [Change Log](#change-log)
14. [Watching Changes](#watching-changes)
15. [Documentation](#documentation)
16. [Examples](#examples)
17. [License](#license)

---

## Why jsonvault

- 📁 **Files you can inspect** – every collection is a plain JSON file (or chunked JSON) that plays nicely with git, rsync, and existing tooling.
- 🧮 **Query power without a server** – expressive filters (`$and`/`$regex`/`$elemMatch`), compiled JSONPath, streaming cursors, and SQL that now speaks `JOIN` and `HAVING`.
- 🛡️ **Safety nets included** – declarative schemas, TTL indexes, change log replay, field-level encryption, and transactional updates.
- 👩‍💻 **Developer-first ergonomics** – async API, easy hooks, TypeScript definitions, `jsonvault` CLI, and code-first migrations.

---

## Install

| npm | pnpm | bun |
| --- | --- | --- |
| `npm install jsonvault` | `pnpm add jsonvault` | `bun add jsonvault` |

> Need a one-off run? Use `npx jsonvault list ./data` right after install to explore your collections.

---

## Hello jsonvault

```js
const { JsonDatabase, Sort } = require("jsonvault");

(async () => {
  const db = await JsonDatabase.open({ path: "./data" });
  const users = db.collection("users");

  await users.insertOne({ name: "Ada", email: "ada@example.com" });

  const ada = await users.findOne({ email: { $endsWith: "@example.com" } });
  console.log(ada);

  await users.updateOne({ _id: ada._id }, { $set: { active: true } });

  await db.save();
})();
```

---

## Core Capabilities

| | |
| --- | --- |
| 📄 **Document API** | insert, find, update, replace, delete, count, distinct, and more. |
| 🧩 **Hooks & validators** | plug custom logic before/after writes, enrich documents, or enforce rules. |
| 🧬 **Schema engine** | defaults, nested fields, transforms, and custom validation callbacks. |
| 🔐 **Encryption & partitioning** | optional per-field encryption plus chunked storage for large collections. |
| ⚙️ **Indexes** | unique, secondary, and TTL indexes for query acceleration and automatic expiry. |
| 🛠️ **Tooling** | SQL + JSONPath helper, file-based migrations, CLI utilities, change log replay, and backups. |

---

## Data Access

> Choose the flavour you prefer: fluent filter objects, SQL, or pre-compiled streams – they all land on the same engine.

### Collections & Queries

```js
const posts = db.collection("posts", {
  validator: (doc) => {
    if (!doc.title) throw new Error("title is required");
  },
  hooks: {
    afterInsert: (doc) => console.log("new post", doc._id),
  },
});

await posts.insertMany([
  { title: "Welcome", category: "intro", publishedAt: new Date() },
  { title: "Indexes", category: "guide", publishedAt: new Date() },
]);

const guides = await posts.find(
  { category: "guide" },
  { projection: { title: 1 }, sort: { publishedAt: Sort.DESC } },
);

const categoryCounts = await posts.countBy("category");
console.log(categoryCounts);

await posts.ensureIndex("publishedAt", { ttlSeconds: 60 * 60 * 24 });

const firstPost = await posts.at(0);
console.log(firstPost?.title);
```

### SQL Helper

Use SQL when you want familiar syntax, aggregates, or lightweight joins. Template parameters are safely injected, and JSONPath strings still work.

```js
const from = new Date("2023-01-01T00:00:00Z");
const to = new Date("2023-12-31T23:59:59Z");

const totals = await db.sql`
  SELECT userId, SUM(total) AS totalSpent
  FROM orders
  WHERE status = 'paid' AND createdAt BETWEEN ${from} AND ${to}
  GROUP BY userId
  ORDER BY totalSpent DESC
`;
// [{ userId: "alice", totalSpent: 350 }]

const ordersWithEmail = await db.sql`
  SELECT orders.id AS orderId, users.email
  FROM orders
  JOIN users ON orders.userId = users._id
  ORDER BY orderId
`;
// [{ orderId: "o1", users: { email: "alice@example.com" } }, ...]
```

Supported today:

- `SELECT` with field aliases plus aggregates (`SUM`, `AVG`, `MIN`, `MAX`, `COUNT`)
- `WHERE` with `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN (...)`, `BETWEEN … AND …`
- Multiple `JOIN`s (including `LEFT JOIN`) with table aliases; `GROUP BY`, `HAVING`, `ORDER BY`
- Sub-selects in `FROM` clauses: `FROM (SELECT ...) AS alias`
- Pagination helpers: `LIMIT`, `OFFSET`, `COUNT(*) OVER()` for total counts
- Template parameters (`${value}`) and JSONPath passthrough (`db.sql("$.orders[?(@.total > 1000)]")`)

### Compiled Queries & Streaming

```js
const query = db.compile("$.orders[?(@.total > 1000 && @.status == 'complete')]");

for await (const order of db.stream(query)) {
  console.log(order.total);
}

const filterQuery = db.compile({
  collection: "orders",
  filter: { total: { $gt: 1000 } },
  options: { sort: { total: Sort.DESC } },
});

for await (const order of db.stream(filterQuery)) {
  console.log(order.total);
}
```

Compiled queries make it easy to reuse filters and iterate lazily over results. The string form supports expressions such as `$.collection[?(@.field > value && @.other == 'foo')]` with basic `&&`/`||`.

---

## Policies & Access Control

Secure reads and writes without a separate service layer. Policies run on every operation and can redact fields before they leave the database.

```js
const db = await JsonDatabase.open({ path: "./data" });

db.policy("orders", {
  read({ row, ctx }) {
    if (!ctx) return false;
    return ctx.role === "admin" || row.userId === ctx.userId;
  },
  write({ previous, next, ctx, operation }) {
    if (!ctx) return false;
    if (ctx.role === "admin") return true;
    if (operation === "insert") return next?.userId === ctx.userId;
    if (operation === "update") {
      return previous?.userId === ctx.userId && next?.userId === ctx.userId;
    }
    if (operation === "delete") return previous?.userId === ctx.userId;
    return false;
  },
  redact({ row, ctx }) {
    return ctx?.role === "admin" ? row : { ...row, internalNotes: undefined };
  },
});

const scoped = db.with({ userId: "alice", role: "user" });

const aliceOrders = await scoped.collection("orders").find();
// -> only Alice's rows, internalNotes removed

try {
  await scoped.collection("orders").insertOne({ userId: "bob", total: 10 });
} catch (error) {
  if (error instanceof PolicyDeniedError) {
    console.log("Denied:", error.message);
  }
}
```

- `db.with(context)` uses async-local propagation so nested calls (collection API, SQL helper, streams) inherit the same context.
- `db.get("orders/o1")` runs through the policy pipeline and returns a redacted document (or `null`).
- Failed writes raise `PolicyDeniedError`, which you can map to HTTP `403` responses.

---

## Error Handling

Operations throw typed errors so you can branch on intent instead of parsing strings. Every error includes a stable `.code` and optional `.details`.

| Class | Code | When it fires |
| ----- | ---- | ------------- |
| `InvalidArgumentError` | `ERR_INVALID_ARGUMENT` | Bad input (missing path, malformed config, invalid operator, etc.) |
| `InvalidOperationError` | `ERR_INVALID_OPERATION` | Action is not permitted in the current state (e.g. primary key change, changelog disabled) |
| `AlreadyExistsError` | `ERR_ALREADY_EXISTS` | Resource collisions such as duplicate documents or migrations |
| `NotFoundError` | `ERR_NOT_FOUND` | Requested migration/adaptor/file is missing |
| `QueryError` | `ERR_QUERY` | SQL / compiled query parsing and execution failures |
| `PolicyDeniedError` | `ERR_POLICY_DENIED` | Access blocked by a collection policy |
| `JsonVaultError` | `ERR_JSONVAULT` | Base class; generic internal failures bubble up with this code |

Use them in higher layers:

```js
try {
  await db.collection("orders").insertOne(payload);
} catch (error) {
  if (error instanceof AlreadyExistsError) {
    res.status(409).json({ code: error.code, message: error.message });
    return;
  }
  throw error; // fall back to global handler
}
```

---

## Data Integrity

### Hooks

Collections can run async lifecycle hooks. Mutate the provided copies to enrich or reject documents.

```js
const posts = db.collection("posts", {
  hooks: {
    beforeInsert(doc) {
      doc.slug = doc.title.toLowerCase().replace(/\s+/g, "-");
    },
    afterInsert(doc) {
      console.log("inserted", doc._id);
    },
    beforeUpdate({ previous, next, update }) {
      if (update.$set?.status === "archived" && !previous.archivedAt) {
        next.archivedAt = new Date().toISOString();
      }
    },
    afterUpdate({ previous, next }) {
      console.log("status changed", previous.status, "→", next.status);
    },
    beforeDelete(doc) {
      console.log("removing", doc._id);
    },
    afterDelete(doc) {
      console.log("removed", doc._id);
    },
  },
});
```

Hooks run in the order shown above and may be `async`. `beforeInsert` receives a mutable document; the other hooks receive cloned snapshots. Repeated calls to `db.collection(name, { hooks })` merge handlers.

### Schemas

```js
const { JsonDatabase, createSchema } = require("jsonvault");

const db = await JsonDatabase.open();

const userSchema = createSchema({
  fields: {
    name: { type: "string", required: true, minLength: 2, trim: true },
    email: {
      type: "string",
      required: true,
      pattern: ".+@.+\\..+",
      transform: (value) => value.toLowerCase(),
    },
    age: { type: "number", min: 0, default: 0 },
    roles: { type: "array", items: "string", default: () => [] },
    profile: {
      type: "object",
      fields: {
        theme: { type: "string", enum: ["light", "dark"], default: "light" },
      },
      allowAdditional: false,
    },
  },
  allowAdditional: false,
});

const users = db.collection("users", { schema: userSchema });

await users.insertOne({ name: "Ada", email: "ADA@example.com" });
// defaults applied, email lowercased, roles set to []

await users.insertOne({ name: "B", email: "broken" });
// throws: schema violation (name too short, invalid email)
```

Schemas run before custom validators and hooks, so you can combine them freely.

### Field Encryption

```js
const db = await JsonDatabase.open({ path: "./data" });

const users = db.collection("users", {
  encryption: {
    secret: process.env.JSONVAULT_SECRET,
    fields: ["password", "tokens.refresh"],
  },
});

await users.insertOne({
  email: "encrypted@example.com",
  password: "p@ssw0rd",
  tokens: { refresh: "secret-refresh-token" },
});

await db.save();
```

Encrypted fields are stored as ciphertext on disk but stay readable in memory. Reopen the database with the same `encryption.secret` to decrypt automatically.

### Transactions

```js
await db.transaction(async (session) => {
  const balances = session.collection("balances");

  await balances.updateOne(
    { userId: "alice" },
    { $inc: { amount: -100 } },
    { upsert: true },
  );

  await balances.updateOne(
    { userId: "bob" },
    { $inc: { amount: 100 } },
    { upsert: true },
  );
});
```

If the callback throws, data snaps back to the pre-transaction state.

### TTL Indexes

```js
const db = await JsonDatabase.open({ ttlIntervalMs: 30_000 });
const sessions = db.collection("sessions");

await sessions.ensureIndex("createdAt", { ttlSeconds: 3600 });

await sessions.insertOne({ user: "alice", createdAt: new Date() });
await sessions.insertOne({ user: "bob", createdAt: new Date(Date.now() - 10 * 3600 * 1000) });

await db.purgeExpired(); // removes Bob's session
```

Tune `ttlIntervalMs` to control the background sweep cadence, or set it to `0` and call `purgeExpired()` manually.

---

## Storage & Scale

### Partitioning Large Collections

```js
const logs = db.collection("logs", {
  partition: {
    chunkSize: 10_000,
    key: "ts",
  },
});

await logs.insertMany(events);
await db.save();

const plan = logs.explain({ ts: { $lt: Date.now() - 1_000 } });
console.log(plan.scannedChunks, "chunks scanned");
```

When `chunkSize` is set, jsonvault writes chunk files (`logs.chunk-0001.json`) to keep large datasets snappy. Run `db.save()` or `db.compact()` periodically to rewrite stale chunks.

### Adapters

```js
const db = await JsonDatabase.open({
  path: "./data-yaml",
  adapter: "yaml",
});

registerAdapter("memory", () => new InMemoryAdapter());

const names = listAdapters();
console.log(names);
```

`jsonvault` ships with `json`, `yaml`, and `memory` adapters. YAML requires the optional `yaml` package (`npm install yaml`). Register a factory to support remote drivers or custom formats.

### Indexes

```js
await users.ensureIndex("email", { unique: true });
await users.insertOne({ email: "unique@example.com" });
await users.insertOne({ email: "unique@example.com" }); // throws
```

Indexes rebuild on load and stay synchronized as documents change.

---

## Tooling & Automation

### CLI Highlights

```sh
npx jsonvault list ./data
npx jsonvault stats ./data
npx jsonvault dump ./data users --limit=5 --filter='{"active":true}'
npx jsonvault export ./data users --format=csv --out=users.csv
jsonvault stats ./data --adapter=yaml
npx jsonvault put ./data/users orders/o99 '{"total":123,"status":"pending"}'
npx jsonvault get ./data/users orders/o99
npx jsonvault snapshot ./data/users --label=release --sign
npx jsonvault query ./data "SELECT userId, SUM(total) AS spend FROM orders GROUP BY userId"
npx jsonvault migrate ./data create add-status --dir=./migrations
npx jsonvault migrate ./data up --dir=./migrations
npx jsonvault migrate ./data down --step=1 --dir=./migrations
npx jsonvault migrate ./data status --dir=./migrations
npx jsonvault migrate ./data status --json --dir=./migrations
jsonvault changelog tail ./data --limit=25
jsonvault stats --config=.jsonvault.config.json
```

### Migrations

Create versioned scripts and let jsonvault track them in `meta.json`. Each migration runs inside a transaction.

```js
// migrations/20240508-add-status.js
module.exports = {
  async up(db) {
    const orders = db.collection("orders");
    await orders.updateMany(
      { status: { $exists: false } },
      { $set: { status: "pending" } },
    );
  },

  async down(db) {
    const orders = db.collection("orders");
    await orders.updateMany({}, { $unset: { status: true } });
  },
};
```

Scaffold and run them:

```sh
jsonvault migrate ./data create add-status --dir=./migrations
jsonvault migrate ./data up --dir=./migrations
jsonvault migrate ./data down --step=1 --dir=./migrations
jsonvault migrate ./data status --dir=./migrations
```

Or roll with code:

```js
const { migrateUp, migrationStatus } = require("jsonvault");

await migrateUp(db, { directory: "./migrations" });
const status = await migrationStatus(db, { directory: "./migrations" });
console.log(status.pending);
```

### Configuration & editor helpers

Load shared CLI defaults (path, adapter, change log) with `--config=<file>`:

```json title=".jsonvault.config.json"
{
  "database": {
    "path": "./data",
    "adapter": "json",
    "changeLog": {
      "path": "./data/changelog/log.jsonl",
      "maxEntries": 10_000,
      "autoArchive": true
    }
  },
  "migrations": {
    "directory": "./migrations"
  }
}
```

Every command respects these defaults. For example, `jsonvault migrate --config=.jsonvault.config.json status --json` prints machine-friendly state without repeating flags.

For quick scaffolding, import the VSCode snippets in `docs/snippets/jsonvault.code-snippets`. They cover common SQL helpers and migration templates. TypeScript users also get named exports for the main helpers: `JsonDatabaseOptions`, `ChangeLogOptions`, `Sort`, `migrations`, and `FileStorageAdapter` are all surfaced via `require("jsonvault")` with full typings.

### Backups

```js
const backupPath = await db.backup();
console.log("Backup stored at:", backupPath);
```

Pass a directory when you need a specific destination.

---

## Change Log

Enable the built-in change log to persist every mutation. Each entry receives a sequential `seq` so you can resume change streams or drive external CDC pipelines.

```js
const db = await JsonDatabase.open({
  path: "./data",
  changeLog: { path: "./data/changelog.jsonl" },
});

await db.collection("users").insertOne({ name: "Change Log" });

const entries = await db.changeLog.read();
console.log(entries[entries.length - 1].seq); // e.g. 3

const tail = await db.changeLog.read({ from: entries[entries.length - 1].seq });
console.log(tail);
```

Log entries mirror watcher payloads, making it trivial to replay into downstream systems or reconnect watchers.

### Retention & rotation

Keep the journal under control with `maxEntries`, `maxSize`, and `autoArchive`. When thresholds are exceeded jsonvault trims the oldest entries (and, if enabled, writes them to `<log>/archive/log-*.jsonl`).

```js
const db = await JsonDatabase.open({
  path: "./data",
  changeLog: {
    path: "./data/changelog/log.jsonl",
    maxEntries: 50_000,
    maxSize: 5 * 1024 * 1024, // 5 MiB
    autoArchive: true,
  },
});
```

Use `read({ limit: 100 })` to fetch only the tail. Sequence numbers stay monotonic even after rotation, so CDC consumers can resume safely from the last `seq`.

### CLI tail & CDC recipes

Pipe the change log straight to a shell or script:

```sh
jsonvault changelog tail ./data --limit=50
jsonvault changelog tail ./data --from=1200 --limit=100 --log=/tmp/custom.log
```

Pair it with `--config` for hands-free exports, or run `jsonvault migrate status --json` in CI to verify rollout status. When you deploy CDC workers, watch the archive directory: if a consumer is down for a while, replay archived segments in order before reading the live log.

---

## Watching Changes

```js
const db = await JsonDatabase.open({ path: "./data" });

const subscription = db.watch("users/**");
subscription.on("change", (event) => {
  console.log(event.type, event.collection, event.paths);
});

const users = db.collection("users");
await users.insertOne({ name: "Watcher Test" });

subscription.close();
await db.close();
```

Watchers observe changes that flow through the current `JsonDatabase` instance. For cross-process updates, consume the change log or pipe events through your own transport.

---

## Documentation

- **Live docs:** https://jsonvault.dev/ – Docusaurus site with guides, concepts, and reference material.
- **Run locally:** `npm install` followed by `npm run docs:start` (serves on `http://localhost:3000`).
- **Build static site:** `npm run docs:build` writes to `docs-site/build`; deploy it to GitHub Pages, Netlify, or any static host.
- **Edit content:** Markdown and MDX files live under `docs-site/docs`. Sidebars and theme config reside in `docs-site/sidebars.js` and `docs-site/docusaurus.config.js`.

---

## Examples

- `examples/partition-demo.js` – generates partitioned data and demonstrates chunk explain plans.
- `examples/basic.js` – minimal script for quick experiments.

Run `npm run bench` to execute the built-in benchmark (`JSONVAULT_BENCH_DOCS` controls document count).

---

## License

jsonvault is released under the MIT License. See [LICENSE](LICENSE) for details.
