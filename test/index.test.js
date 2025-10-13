"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { JsonDatabase, FileStorageAdapter, queryDocuments } = require("../src");

const createTempDir = async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bungfro-json-"));
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
