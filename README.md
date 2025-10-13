# jsonvault

jsonvault is a JSON document database for Node and Bun. It keeps data in plain files, supports async operations, and stays light on dependencies.

## What it does

- Stores each collection as a JSON file on disk.
- Provides insert, find, update, delete, and count helpers.
- Supports filter operators like `$eq`, `$in`, `$regex`, `$and`, `$or`, `$exists`, `$contains`, `$startsWith`, and `$endsWith`.
- Maintains secondary indexes with optional uniqueness checks.
- Supports TTL indexes that remove expired documents without manual cleanup.
- Offers declarative schemas with defaults, nested rules, and custom validators.
- Offers autosave, manual `save()` and `backup()` methods, and a simple transaction helper built on in-memory snapshots.
- Ships with hooks and an optional validator so you can plug in your own logic.
- Includes TypeScript definitions.

## Install

```sh
npm install jsonvault
# or
pnpm add jsonvault
# or
bun add jsonvault
```

## Quick start

```js
const { JsonDatabase } = require("jsonvault");

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

## Collections and queries

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
  { projection: { title: 1 }, sort: { publishedAt: -1 } },
);

const categoryCounts = await posts.countBy("category");
console.log(categoryCounts);

await posts.ensureIndex("publishedAt", { ttlSeconds: 60 * 60 * 24 });

const firstPost = await posts.at(0);
console.log(firstPost?.title);
```

## Schemas

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

Schemas run before custom validators and hooks, so you can combine them when you need extra checks.

## Indexes

```js
await users.ensureIndex("email", { unique: true });
await users.insertOne({ email: "unique@example.com" });
await users.insertOne({ email: "unique@example.com" }); // throws
```

Indexes rebuild when the database loads and stay in sync as data changes.

## Transactions

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

If the callback throws, data returns to its pre-transaction state.

## TTL indexes

```js
const db = await JsonDatabase.open({ ttlIntervalMs: 30_000 });
const sessions = db.collection("sessions");

await sessions.ensureIndex("createdAt", { ttlSeconds: 3600 });

await sessions.insertOne({ user: "alice", createdAt: new Date() });
await sessions.insertOne({ user: "bob", createdAt: new Date(Date.now() - 10 * 3600 * 1000) });

// Bob's session disappears on the next TTL sweep
await db.purgeExpired(); // run manually or wait for the background job
```

Use the `ttlIntervalMs` option to control how often the background scan runs. Set it to `0` to disable automatic sweeps and rely on manual `purgeExpired()` calls instead.

## Backups

```js
const backupPath = await db.backup();
console.log("Backup stored at:", backupPath);
```

Pass a directory to `backup()` if you need a specific destination.

## TypeScript

```ts
import { JsonDatabase } from "jsonvault";

type User = {
  _id: string;
  email: string;
  name: string;
  roles: string[];
};

const db = await JsonDatabase.open();
const users = db.collection<User>("users");

const inserted = await users.insertOne({ email: "hi@example.com", name: "Hi", roles: [] });
inserted.roles.push("member");
```

## Testing

```sh
npm test
```

This runs the storage, index, transaction, and query tests.

## Benchmarks

```sh
npm run bench
```

Runs a simple benchmark that inserts documents, executes queries, and reports timings. Set `JSONVAULT_BENCH_DOCS` to change the document count.

## Looking ahead

- Alternative storage formats for larger data sets.
