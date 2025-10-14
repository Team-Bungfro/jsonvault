"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { performance } = require("perf_hooks");

const { JsonDatabase, createSchema, Sort } = require("../src");

const FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const now = () => performance.now();

const log = (label, value, unit = "ms") => {
  console.log(
    `${label.padEnd(20)} ${FORMATTER.format(value)} ${unit}`,
  );
};

const createTempPath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonvault-bench-"));
  return dir;
};

const main = async () => {
  const TEMP_PATH = await createTempPath();
  const TOTAL_DOCS = Number(process.env.JSONVAULT_BENCH_DOCS) || 10_000;
  const ADAPTER = process.env.JSONVAULT_BENCH_ADAPTER || "json";
  const PARTITION_ENABLED = /^(1|true|yes)$/i.test(
    process.env.JSONVAULT_BENCH_PARTITION || "false",
  );

  if (ADAPTER === "yaml") {
    try {
      require("yaml");
    } catch (error) {
      console.error(
        "YAML adapter selected but 'yaml' package is not installed. Run `npm install yaml`.",
      );
      process.exit(1);
    }
  }

  const userSchema = createSchema({
    fields: {
      name: { type: "string", required: true },
      email: { type: "string", required: true },
      age: { type: "number", default: 0 },
      tags: { type: "array", items: "string", default: () => [] },
      active: { type: "boolean", default: false },
    },
    allowAdditional: false,
  });

  const db = await JsonDatabase.open({
    path: TEMP_PATH,
    autosave: false,
    adapter: ADAPTER,
  });
  
  const users = db.collection("users", {
    schema: userSchema,
    partition: PARTITION_ENABLED
      ? {
          chunkSize: 2_000,
          key: "age",
        }
      : undefined,
  });

  const payload = [];
  for (let i = 0; i < TOTAL_DOCS; i += 1) {
    payload.push({
      name: `User ${i}`,
      email: `user${i}@example.com`,
      age: i % 90,
      tags: i % 2 === 0 ? ["even"] : ["odd"],
    });
  }

  console.log(
    `Running benchmark with ${TOTAL_DOCS.toLocaleString()} documents (adapter=${ADAPTER}, partition=${PARTITION_ENABLED})...\n`,
  );

  let start = now();
  await users.insertMany(payload);
  const insertDuration = now() - start;
  log("insertMany", insertDuration);

  start = now();
  const mid = await users.findOne({ email: "user500@example.com" });
  const findOneDuration = now() - start;
  log("findOne", findOneDuration);

  start = now();
  const filterQuery = { age: { $gte: 40, $lt: 80 } };
  const filtered = await users.find(filterQuery, {
    sort: { age: Sort.ASC },
    limit: 100,
  });
  const findDuration = now() - start;
  log("find (100 match)", findDuration);

  const plan = users.explain(filterQuery);
  if (plan) {
    console.log(
      `  plan: scanned ${plan.scannedChunks}/${plan.totalChunks} chunks, ${plan.documentsScanned} docs`,
    );
  }

  start = now();
  await users.updateMany(
    { tags: { $contains: "even" } },
    { $set: { active: true } },
  );
  const updateDuration = now() - start;
  log("updateMany", updateDuration);

  start = now();
  const count = await users.count({ active: true });
  const countDuration = now() - start;
  log("count (active)", countDuration);

  console.log("\nSamples:");
  console.log("findOne result:", mid);
  console.log("find length:", filtered.length);
  if (plan) {
    console.log("plan:", plan);
  }
  console.log("count:", count);

  await db.close();
  await fs.rm(TEMP_PATH, { recursive: true, force: true });
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
