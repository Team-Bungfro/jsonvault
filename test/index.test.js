"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  JsonDatabase,
  FileStorageAdapter,
  queryDocuments,
  createSchema,
  Sort,
  registerAdapter,
  listAdapters,
  migrateUp,
  migrateDown,
  migrationStatus,
  migrations,
} = require("../src");

const createTempDir = async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jsonvault-"));
  return tmp;
};

test("JsonDatabase basic CRUD flow", async (t) => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });

  t.after(async () => {
    await db.close();
  });

  const users = db.collection("users");
  const inserted = await users.insertOne({ name: "Ada", roles: ["admin"] });

  assert.ok(inserted._id, "Inserted document should have an _id");

  const found = await users.findOne({ name: "Ada" });
  assert.equal(found.name, "Ada");

  await users.updateOne({ _id: inserted._id }, { $set: { active: true } });
  const updated = await users.findById(inserted._id);
  assert.equal(updated.active, true);

  const count = await users.count();
  assert.equal(count, 1);

  await users.deleteOne({ _id: inserted._id });
  const afterDelete = await users.findOne({ _id: inserted._id });
  assert.equal(afterDelete, null);
});

test("FileStorageAdapter writes collections to disk", async (t) => {
  const tempDir = await createTempDir();
  const storage = new FileStorageAdapter({ directory: tempDir });

  await storage.init();
  const db = await JsonDatabase.open({
    path: tempDir,
    autosave: false,
    storage,
  });

  t.after(async () => {
    await db.close();
  });

  const posts = db.collection("posts");
  await posts.insertMany([
    { title: "Hello", tags: ["intro"] },
    { title: "Advanced", tags: ["json", "index"] },
  ]);

  await db.save();

  const collections = await storage.listCollections();
  assert.deepEqual(collections, ["posts"]);

  const payload = await storage.readCollection("posts");
  assert.equal(payload.documents.length, 2);
});

test("secondary indexes accelerate filtering", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const products = db.collection("products");

  await products.insertMany([
    { sku: "A-01", price: 10 },
    { sku: "B-02", price: 20 },
    { sku: "C-03", price: 30 },
  ]);

  await products.ensureIndex("sku", { unique: true });

  const found = await products.findOne({ sku: "B-02" });
  assert.equal(found.price, 20);

  await assert.rejects(
    () => products.insertOne({ sku: "B-02", price: 40 }),
    /Duplicate value/,
  );

  await db.close();
});

test("transactions roll back on failure", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const orders = db.collection("orders");

  await orders.insertOne({ customer: "alice", total: 100 });

  await assert.rejects(
    () =>
      db.transaction(async (session) => {
        const col = session.collection("orders");
        await col.insertOne({ customer: "bob", total: 200 });
        throw new Error("Boom");
      }),
    /Boom/,
  );

  const all = await orders.find();
  assert.equal(all.length, 1);
  assert.equal(all[0].customer, "alice");

  await db.close();
});

test("queryDocuments helper matches nested criteria", () => {
  const docs = [
    { name: "Ada", address: { city: "London" }, tags: ["mathematician"] },
    { name: "Grace", address: { city: "Baltimore" }, tags: ["scientist"] },
  ];

  const result = queryDocuments(docs, {
    "address.city": { $regex: "lon", $options: "i" },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Ada");
});

test("createMigration scaffolds a template file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonvault-migrations-create-"));
  const { id, file } = await migrations.createMigration({ directory: dir, name: "Add Users" });

  assert.ok(id.length > 0);
  const stats = await fs.stat(file);
  assert.ok(stats.isFile());
  assert.ok(file.endsWith(`${id}.js`));

  const contents = await fs.readFile(file, "utf8");
  assert.match(contents, /async up\(db\)/);
  assert.match(contents, /async down\(db\)/);
});

test("advanced operators support $all, $elemMatch, $mod, $type, and field-level $not", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const items = db.collection("items");

  await items.insertMany([
    {
      name: "bundle",
      tags: ["tech", "sale", "bundle"],
      variants: [
        { sku: "A", price: 25, active: true },
        { sku: "B", price: 45, active: true },
      ],
      orderNumber: 24,
      meta: { featured: true },
      status: "active",
    },
    {
      name: "single",
      tags: ["tech"],
      variants: [{ sku: "C", price: 15, active: true }],
      orderNumber: 25,
      meta: null,
      status: "archived",
    },
  ]);

  const allTags = await items.find({ tags: { $all: ["tech", "sale"] } });
  assert.equal(allTags.length, 1);
  assert.equal(allTags[0].name, "bundle");

  const matchingVariant = await items.find({
    variants: { $elemMatch: { price: { $gt: 30 }, active: true } },
  });
  assert.equal(matchingVariant.length, 1);
  assert.equal(matchingVariant[0].name, "bundle");

  const moduloMatches = await items.find({ orderNumber: { $mod: [2, 0] } });
  assert.equal(moduloMatches.length, 1);
  assert.equal(moduloMatches[0].name, "bundle");

  const typedMeta = await items.find({ meta: { $type: "object" } });
  assert.equal(typedMeta.length, 1);
  assert.equal(typedMeta[0].name, "bundle");

  const notArchived = await items.find({ status: { $not: { $eq: "archived" } } });
  assert.equal(notArchived.length, 1);
  assert.equal(notArchived[0].name, "bundle");

  await db.close();
});

test("migrations apply and rollback changes", async () => {
  const tempDir = await createTempDir();
  const migrationsDir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonvault-migrations-"));

  await fs.writeFile(
    path.join(migrationsDir, "001-create-users.js"),
    `"use strict";
module.exports = {
  async up(db) {
    const users = db.collection("users");
    await users.insertOne({ name: "seed" });
  },
  async down(db) {
    await db.dropCollection("users");
  },
};
`,
    "utf8",
  );

  await fs.writeFile(
    path.join(migrationsDir, "002-tag-users.js"),
    `"use strict";
module.exports = {
  async up(db) {
    const users = db.collection("users");
    await users.updateMany({}, { $set: { active: true } });
  },
  async down(db) {
    const users = db.collection("users");
    await users.updateMany({}, { $unset: { active: true } });
  },
};
`,
    "utf8",
  );

  const db = await JsonDatabase.open({ path: tempDir, autosave: false });

  const initialStatus = await migrationStatus(db, { directory: migrationsDir });
  assert.equal(initialStatus.applied.length, 0);
  assert.equal(initialStatus.pending.length, 2);

  const upResult = await migrateUp(db, { directory: migrationsDir });
  assert.equal(upResult.ran.length, 2);

  let users = db.collection("users");
  let docs = await users.find();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].active, true);

  const statusAfterUp = await migrationStatus(db, { directory: migrationsDir });
  assert.equal(statusAfterUp.applied.length, 2);
  assert.equal(statusAfterUp.pending.length, 0);

  const rollbackOne = await migrateDown(db, { directory: migrationsDir, step: 1 });
  assert.equal(rollbackOne.ran.length, 1);
  users = db.collection("users");
  docs = await users.find();
  assert.equal(docs[0].active, undefined);

  const rollbackTwo = await migrateDown(db, { directory: migrationsDir, step: 1 });
  assert.equal(rollbackTwo.ran.length, 1);
  const collectionsLeft = db.listCollections();
  assert.equal(collectionsLeft.includes("users"), false);

  const finalStatus = await migrationStatus(db, { directory: migrationsDir });
  assert.equal(finalStatus.applied.length, 0);
  assert.equal(finalStatus.pending.length, 2);

  await db.close();
});

test("countBy groups results by field value", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const events = db.collection("events");

  await events.insertMany([
    { type: "login", user: "alice" },
    { type: "login", user: "bob" },
    { type: "logout", user: "alice" },
    { type: "signup", user: "carol" },
  ]);

  const counts = await events.countBy("type");
  const lookup = Object.fromEntries(counts.map((entry) => [entry.value, entry.count]));

  assert.equal(lookup.login, 2);
  assert.equal(lookup.logout, 1);
  assert.equal(lookup.signup, 1);

  await db.close();
});

test("at returns the nth document respecting filters", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const posts = db.collection("posts");

  await posts.insertMany([
    { title: "First", category: "news" },
    { title: "Second", category: "guide" },
    { title: "Third", category: "guide" },
  ]);

  const first = await posts.at(0);
  assert.equal(first.title, "First");

  const secondGuide = await posts.at(1, { category: "guide" }, { sort: { title: Sort.ASC } });
  assert.equal(secondGuide.title, "Third");

  const missing = await posts.at(5);
  assert.equal(missing, null);

  await db.close();
});

test("encryption stores ciphertext on disk and decrypts on load", async () => {
  const tempDir = await createTempDir();
  const secret = "bench-secret";
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });

  const users = db.collection("users", {
    encryption: {
      secret,
      fields: ["password"],
    },
  });

  await users.insertOne({ email: "user@example.com", password: "p@ss" });
  await db.save();

  const stored = await fs.readFile(
    path.join(tempDir, "collections", "users.collection.json"),
    "utf8",
  );
  const payload = JSON.parse(stored);
  const encryptedPassword = payload.documents[0].password;
  assert.equal(encryptedPassword.__jsonvaultEncrypted, true);

  await db.close();

  const reopened = await JsonDatabase.open({ path: tempDir, autosave: false });
  const reopenedUsers = reopened.collection("users", {
    encryption: {
      secret,
      fields: ["password"],
    },
  });

  const doc = await reopenedUsers.findOne({ email: "user@example.com" });
  assert.equal(doc.password, "p@ss");

  await reopened.close();
});

test("partitioned collection writes chunk files", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const logs = db.collection("logs", {
    partition: { chunkSize: 5, key: "idx" },
  });

  const docs = Array.from({ length: 12 }, (_, idx) => ({ idx }));
  await logs.insertMany(docs);
  await db.save();
  await db.close();

  const chunksDir = path.join(tempDir, "collections", "logs.chunks");
  const files = await fs.readdir(chunksDir);
  assert.equal(files.length, 3);

  const mainFile = await fs.readFile(
    path.join(tempDir, "collections", "logs.collection.json"),
    "utf8",
  );
  const payload = JSON.parse(mainFile);
  assert.equal(payload.documents.length, 0);
  assert.equal(payload.chunks.length, 3);

  const chunkOne = await fs.readFile(path.join(chunksDir, files[0]), "utf8");
  const parsedChunk = JSON.parse(chunkOne);
  assert.equal(parsedChunk.length, 5);

  const reopen = await JsonDatabase.open({ path: tempDir, autosave: false });
  const reopenedLogs = reopen.collection("logs", {
    partition: { chunkSize: 5, key: "idx" },
  });
  const count = await reopenedLogs.count();
  assert.equal(count, 12);

  const plan = reopenedLogs.explain({ idx: { $lt: 5 } });
  assert.ok(plan);
  assert.equal(plan.optimized, true);
  assert.equal(plan.scannedChunks, 1);
  const allPlan = reopenedLogs.explain({});
  assert.ok(allPlan);
  assert.equal(allPlan.optimized, false);

  await reopen.close();
});

test("watch emits change events", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const events = [];
  const handle = db.watch("users/**");
  handle.on("change", (event) => events.push(event));

  const users = db.collection("users");
  const inserted = await users.insertOne({ name: "Watcher" });
  await users.updateOne({ _id: inserted._id }, { $set: { name: "Updated" } });
  await users.deleteOne({ _id: inserted._id });

  handle.close();
  await db.close();

  assert.equal(events.length, 3);
  assert.equal(events[0].type, "insert");
  assert.equal(events[0].documents[0]._id, inserted._id);
  assert.equal(events[1].type, "update");
  assert.equal(events[1].updates[0].next.name, "Updated");
  assert.equal(events[2].type, "delete");
  assert.equal(events[2].deleted[0]._id, inserted._id);
});

test("db.sql executes aggregate queries", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });

  const orders = db.collection("orders");
  const from = new Date("2023-01-01T00:00:00.000Z");
  const to = new Date("2023-12-31T23:59:59.999Z");

  await orders.insertMany([
    { orderId: "o1", userId: "alice", total: 150, status: "paid", createdAt: new Date("2023-03-01T10:00:00.000Z") },
    { orderId: "o2", userId: "alice", total: 200, status: "paid", createdAt: new Date("2023-06-15T12:00:00.000Z") },
    { orderId: "o3", userId: "bob", total: 75, status: "pending", createdAt: new Date("2023-04-20T09:00:00.000Z") },
    { orderId: "o4", userId: "carol", total: 300, status: "paid", createdAt: new Date("2022-11-05T08:00:00.000Z") },
  ]);

  const rows = await db.sql`
    SELECT userId, SUM(total) AS totalSpent
    FROM orders
    WHERE status = 'paid' AND createdAt BETWEEN ${from} AND ${to}
    GROUP BY userId
    ORDER BY totalSpent DESC
  `;

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { userId: "alice", totalSpent: 350 });

  const havingRows = await db.sql`
    SELECT userId, SUM(total) AS totalSpent
    FROM orders
    WHERE status = 'paid' AND createdAt BETWEEN ${from} AND ${to}
    GROUP BY userId
    HAVING totalSpent > 300
  `;
  assert.equal(havingRows.length, 1);
  assert.equal(havingRows[0].userId, "alice");

  const filteredOut = await db.sql`
    SELECT userId, SUM(total) AS totalSpent
    FROM orders
    WHERE status = 'paid' AND createdAt BETWEEN ${from} AND ${to}
    GROUP BY userId
    HAVING totalSpent > 400
  `;
  assert.equal(filteredOut.length, 0);

  await db.close();
});

test("db.sql supports JOIN queries", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });

  const users = db.collection("users");
  await users.insertMany([
    { _id: "alice", email: "alice@example.com" },
    { _id: "bob", email: "bob@example.com" },
  ]);

  const orders = db.collection("orders");
  await orders.insertMany([
    { id: "o1", userId: "alice", total: 100 },
    { id: "o2", userId: "bob", total: 200 },
    { id: "o3", userId: "carol", total: 300 },
  ]);

  const rows = await db.sql`
    SELECT orders.id AS orderId, users.email AS email
    FROM orders
    JOIN users ON orders.userId = users._id
    ORDER BY orderId
  `;

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { orderId: "o1", email: "alice@example.com" });
  assert.deepEqual(rows[1], { orderId: "o2", email: "bob@example.com" });

  await db.close();
});

test("db.sql supports JSONPath expressions", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });

  const users = db.collection("users");
  await users.insertMany([
    { name: "Ada", age: 36 },
    { name: "Grace", age: 45 },
  ]);

  const results = await db.sql("$.users[?(@.age >= 40)]");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "Grace");

  await db.close();
});

test("change log records change events", async () => {
  const tempDir = await createTempDir();
  const logPath = path.join(tempDir, "changelog.jsonl");
  const db = await JsonDatabase.open({
    path: tempDir,
    autosave: false,
    changeLog: { path: logPath },
  });

  const users = db.collection("users");
  await users.insertOne({ name: "Alice" });
  await users.updateMany({ name: "Alice" }, { $set: { active: true } });
  await users.deleteOne({ name: "Alice" });

  const entries = await db.changeLog.read();
  assert.ok(entries.length >= 3);
  assert.equal(entries[0].type, "insert");
  assert.equal(entries[1].type, "update");
  assert.equal(entries[2].type, "delete");
  const lastSeq = entries[entries.length - 1].seq;

  await db.close();

  const reopened = await JsonDatabase.open({
    path: tempDir,
    autosave: false,
    changeLog: { path: logPath },
  });
  const tail = await reopened.changeLog.read({ from: lastSeq });
  assert.ok(tail.length >= 1);
  assert.equal(tail[0].seq, lastSeq);
  await reopened.close();
});

test("yaml adapter stores data with .yaml extension", async (t) => {
  let yaml;
  try {
    yaml = require("yaml");
  } catch (error) {
    t.skip("yaml package not installed");
    return;
  }

  assert.ok(yaml, "yaml dependency should load");

  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({
    path: tempDir,
    autosave: false,
    adapter: "yaml",
  });

  const users = db.collection("users");
  await users.insertOne({ name: "YAML" });
  await db.save();
  await db.close();

  const collectionsDir = path.join(tempDir, "collections");
  const files = await fs.readdir(collectionsDir);
  assert.ok(files.some((file) => file.endsWith(".collection.yaml")));
});

test("custom adapter registration", async () => {
  const adaptersBefore = listAdapters();
  class MemoryAdapter {
    constructor() {
      this.meta = { version: 1 };
      this.collections = new Map();
    }

    async init() {}

    async readMeta() {
      return { ...this.meta };
    }

    async writeMeta(meta) {
      this.meta = { ...this.meta, ...meta };
      return this.meta;
    }

    async listCollections() {
      return Array.from(this.collections.keys());
    }

    async readCollection(name) {
      if (this.collections.has(name)) {
        return JSON.parse(JSON.stringify(this.collections.get(name)));
      }
      return {
        name,
        documents: [],
        indexes: {},
        options: {},
      };
    }

    async writeCollection(name, payload) {
      this.collections.set(name, JSON.parse(JSON.stringify(payload)));
    }

    async deleteCollection(name) {
      this.collections.delete(name);
    }

    async backup() {
      return "";
    }
  }

  registerAdapter("memory-test", () => new MemoryAdapter());
  const adaptersAfter = listAdapters();
  assert.ok(adaptersAfter.length >= adaptersBefore.length);

  const db = await JsonDatabase.open({
    adapter: "memory-test",
    autosave: false,
  });

  const users = db.collection("users");
  await users.insertOne({ name: "Memory" });
  const count = await users.count();
  assert.equal(count, 1);

  await db.close();
});

test("snapshot and restore revert state", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const items = db.collection("items");

  await items.insertOne({ name: "before" });
  const snapshot = await db.snapshot();

  await items.insertOne({ name: "after" });
  let count = await items.count();
  assert.equal(count, 2);

  await db.restore(snapshot);
  count = await items.count();
  assert.equal(count, 1);

  const doc = await items.findOne();
  assert.equal(doc.name, "before");

  await db.close();
});

test("compile filter spec returns streaming results", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const orders = db.collection("orders");

  await orders.insertMany([
    { total: 500 },
    { total: 1500 },
    { total: 2000 },
  ]);

  const query = db.compile({
    collection: "orders",
    filter: { total: { $gt: 1000 } },
  });

  const totals = [];
  for await (const row of db.stream(query)) {
    totals.push(row.total);
  }

  assert.deepEqual(totals, [1500, 2000]);

  await db.close();
});

test("compile expression supports simple syntax", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });
  const orders = db.collection("orders");

  await orders.insertMany([
    { total: 900, status: "pending" },
    { total: 1100, status: "complete" },
    { total: 2500, status: "complete" },
    { total: 3000, status: "pending" },
  ]);

  const query = db.compile("$.orders[?(@.total > 1000 && @.status == 'complete')]");
  const totals = [];
  for await (const row of db.stream(query)) {
    totals.push(row.total);
  }

  assert.deepEqual(totals, [1100, 2500]);

  const orQuery = db.compile("$.orders[?(@.status == 'pending' || @.total >= 2500)]");
  const orTotals = [];
  for await (const row of db.stream(orQuery)) {
    orTotals.push(row.total);
  }

  assert.deepEqual(orTotals, [900, 2500, 3000]);

  await db.close();
});

test("schema validation applies defaults and rejects invalid docs", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({ path: tempDir, autosave: false });

  const userSchema = createSchema({
    fields: {
      name: { type: "string", required: true, minLength: 2 },
      email: {
        type: "string",
        required: true,
        pattern: ".+@.+\\..+",
        transform: (value) => value.toLowerCase(),
      },
      age: { type: "number", min: 0, default: 0 },
      tags: { type: "array", items: "string", default: () => [] },
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

  const inserted = await users.insertOne({
    name: "Ada",
    email: "ADA@example.com",
    profile: {},
  });

  assert.equal(inserted.age, 0);
  assert.deepEqual(inserted.tags, []);
  assert.equal(inserted.email, "ada@example.com");
  assert.equal(inserted.profile.theme, "light");

  await assert.rejects(() =>
    users.insertOne({ email: "bad", profile: {} }),
  );

  await assert.rejects(() =>
    users.updateOne(
      { _id: inserted._id },
      { $set: { profile: { theme: "neon" } } },
    ),
  );

  await users.updateOne(
    { _id: inserted._id },
    { $set: { age: 10, profile: { theme: "dark" } } },
  );

  const updated = await users.findById(inserted._id);
  assert.equal(updated.age, 10);
  assert.equal(updated.profile.theme, "dark");

  await db.close();
});

test("purgeExpired removes stale documents when TTL index is present", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({
    path: tempDir,
    autosave: false,
    ttlIntervalMs: 0,
  });
  const sessions = db.collection("sessions");

  await sessions.ensureIndex("createdAt", { ttlSeconds: 1 });

  await sessions.insertMany([
    { user: "stale", createdAt: new Date(Date.now() - 5_000) },
    { user: "fresh", createdAt: new Date() },
  ]);

  await db.purgeExpired();

  const remaining = await sessions.find({}, { sort: { user: Sort.ASC } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].user, "fresh");

  await db.close();
});

test("TTL interval automatically removes expired documents", async () => {
  const tempDir = await createTempDir();
  const db = await JsonDatabase.open({
    path: tempDir,
    autosave: false,
    ttlIntervalMs: 25,
  });
  const tokens = db.collection("tokens");

  await tokens.ensureIndex("createdAt", { ttlSeconds: 1 });

  await tokens.insertOne({ id: "old", createdAt: new Date(Date.now() - 5_000) });
  await tokens.insertOne({ id: "new", createdAt: new Date() });

  await new Promise((resolve) => setTimeout(resolve, 80));

  const docs = await tokens.find({}, { sort: { id: Sort.ASC } });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, "new");

  await db.close();
});
