---
sidebar_position: 3
title: Migrations
---

JSONVault ships with a simple file-based migration runner. Each migration is a JavaScript module exporting `up` (required) and `down` (optional) functions. Applied migration IDs live in `meta.json`, so the runtime always knows which scripts ran.

## Anatomy of a migration

```js title="migrations/20240508-add-status.js"
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

## CLI workflow

```bash
# Scaffold a new file (timestamped ID)
npx jsonvault migrate ./data create add-status --dir=./migrations

# Apply the next pending migrations (up)
npx jsonvault migrate ./data up --dir=./migrations

# Roll back the most recent migration
npx jsonvault migrate ./data down --step=1 --dir=./migrations

# Inspect status
npx jsonvault migrate ./data status --dir=./migrations
```

- Migrations run inside a transaction by default; throw to abort and roll back.
- The change log records each migration-induced mutation, so downstream consumers stay in sync.
- Use the `--dryRun` flag to preview what would run without touching data.

## Programmatic control

```js
const { migrateUp, migrateDown, migrationStatus } = require("jsonvault");

await migrateUp(db, { directory: "./migrations" });
const status = await migrationStatus(db, { directory: "./migrations" });
console.log(status.pending);

await migrateDown(db, { directory: "./migrations", step: 1 });
```

Choose a naming convention (timestamp or semantic) and stick to it. The runner sorts migrations lexicographically, so `20240508-add-status.js` will always run before `20240509-index-email.js`.
