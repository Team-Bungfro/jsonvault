"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { JsonDatabase, FileStorageAdapter, queryDocuments, createSchema } = require("../src");

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

  const secondGuide = await posts.at(1, { category: "guide" }, { sort: { title: 1 } });
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

  const remaining = await sessions.find({}, { sort: { user: 1 } });
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

  const docs = await tokens.find({}, { sort: { id: 1 } });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, "new");

  await db.close();
});
