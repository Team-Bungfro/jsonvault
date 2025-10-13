# @bungfro/json

@bungfro/json is a JSON document database for Node and Bun. It keeps data in plain files, supports async operations, and stays light on dependencies.

## What it does

- Stores each collection as a JSON file on disk.
- Provides insert, find, update, delete, and count helpers.
- Supports filter operators like `$eq`, `$in`, `$regex`, `$and`, `$or`, `$exists`, `$contains`, `$startsWith`, and `$endsWith`.
- Maintains secondary indexes with optional uniqueness checks.
- Offers autosave, manual `save()` and `backup()` methods, and a simple transaction helper built on in-memory snapshots.
- Ships with hooks and an optional validator so you can plug in your own logic.
- Includes TypeScript definitions.

## Install

```sh
npm install @bungfro/json
# or
pnpm add @bungfro/json
# or
bun add @bungfro/json
```

## Quick start

```js
const { JsonDatabase } = require("@bungfro/json");

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
  { title: "Welcome", tags: ["intro"], publishedAt: new Date() },
  { title: "Indexes", tags: ["guide", "indexes"], publishedAt: new Date() },
]);

const guides = await posts.find(
  { tags: { $contains: "guide" } },
  { projection: { title: 1 }, sort: { publishedAt: -1 } },
);
```

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

## Backups

```js
const backupPath = await db.backup();
console.log("Backup stored at:", backupPath);
```

Pass a directory to `backup()` if you need a specific destination.

## TypeScript

```ts
import { JsonDatabase } from "@bungfro/json";

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

## Looking ahead

- TTL indexes and automatic cleanup.
- Alternative storage formats for larger data sets.
