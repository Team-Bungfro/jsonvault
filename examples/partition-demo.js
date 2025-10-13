"use strict";

const fs = require("fs/promises");
const path = require("path");
const { performance } = require("perf_hooks");

const { JsonDatabase } = require("../src");

const DATA_DIR = path.resolve(__dirname, "../.examples/partition-demo");

const createPayload = (count) => {
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    docs.push({
      ts: Date.now() + i,
      level: i % 3 === 0 ? "error" : i % 3 === 1 ? "warn" : "info",
      message: `Log entry ${i}`,
      meta: {
        shard: i % 16,
        requestId: `req-${i}`,
      },
    });
  }
  return docs;
};

const log = (message, value) => {
  if (value !== undefined) {
    console.log(message, value);
  } else {
    console.log(message);
  }
};

const run = async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });

  const db = await JsonDatabase.open({
    path: DATA_DIR,
    autosave: false,
  });

  const logs = db.collection("logs", {
    partition: {
      chunkSize: 5_000,
      key: "ts",
    },
  });

  const BATCHES = 10;
  const PER_BATCH = 5_000;
  const total = BATCHES * PER_BATCH;

  log(`Writing ${total.toLocaleString()} log documents...`);

  const start = performance.now();

  for (let batch = 0; batch < BATCHES; batch += 1) {
    const payload = createPayload(PER_BATCH).map((doc, index) => ({
      ...doc,
      batch,
      index,
    }));
    await logs.insertMany(payload);
  }

  await db.save();

  const duration = performance.now() - start;
  log("Insert duration (ms):", duration.toFixed(2));

  const stats = await db.stats();
  log("Database stats:", JSON.stringify(stats, null, 2));

  const metaPath = path.join(
    DATA_DIR,
    "collections",
    "logs.collection.json",
  );
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));

  log("Top-level document count:", meta.documents.length);
  log("Chunk descriptors:", meta.chunks.length);

  const chunkDir = path.join(DATA_DIR, "collections", "logs.chunks");
  const chunkFiles = await fs.readdir(chunkDir);
  log("Chunk files:", chunkFiles);

  if (chunkFiles.length > 0) {
    const sampleChunk = JSON.parse(
      await fs.readFile(path.join(chunkDir, chunkFiles[0]), "utf8"),
    );
    log("First chunk sample size:", sampleChunk.length);
  }

  const plan = logs.explain({ ts: { $lt: Date.now() + 500 } });
  log("Explain (ts < now+500):", plan);

  await db.close();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
