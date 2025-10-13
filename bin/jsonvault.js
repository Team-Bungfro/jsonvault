#!/usr/bin/env node
"use strict";

const path = require("path");
const { stdout, stderr, exit, argv } = process;

const { JsonDatabase } = require("../src");

const usage = () => {
  stdout.write(
    [
      "jsonvault <command> [options]",
      "",
      "Commands:",
      "  list <path>                  List collections in a database directory",
      "  stats <path>                 Show database stats",
      "  dump <path> <collection>     Print documents from a collection",
      "  export <path> <collection>   Export documents (default JSON)",
      "",
      "Options for dump:",
      "  --limit=<n>                  Limit number of documents (default: 20)",
      "  --filter=<json>              JSON filter object",
      "",
      "Options for export:",
      "  --limit=<n>                  Limit number of documents",
      "  --filter=<json>              JSON filter object",
      "  --format=<json|csv>          Output format (default json)",
      "  --out=<path>                 Write to file instead of stdout",
      "",
    ].join("\n"),
  );
};

const parseOptions = (rawArgs) => {
  const options = {};
  const positional = [];

  for (const arg of rawArgs) {
    if (arg.startsWith("--")) {
      const [key, value = "true"] = arg.slice(2).split("=");
      options[key] = value;
    } else {
      positional.push(arg);
    }
  }

  return { options, positional };
};

const parseJson = (value, fallback = {}) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${value}`);
  }
};

const flattenDocument = (doc, prefix = "", target = {}) => {
  if (doc === null || typeof doc !== "object") {
    target[prefix || "value"] = doc;
    return target;
  }

  if (Array.isArray(doc)) {
    target[prefix || "value"] = JSON.stringify(doc);
    return target;
  }

  for (const [key, value] of Object.entries(doc)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenDocument(value, nextKey, target);
    } else {
      target[nextKey] = Array.isArray(value) ? JSON.stringify(value) : value;
    }
  }

  return target;
};

const documentsToCsv = (documents) => {
  if (!documents.length) {
    return "";
  }

  const flattened = documents.map((doc) => flattenDocument(doc));
  const headers = Array.from(
    flattened.reduce((set, doc) => {
      Object.keys(doc).forEach((key) => set.add(key));
      return set;
    }, new Set()),
  );

  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[,"\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = [headers.map(escape).join(",")];
  for (const doc of flattened) {
    rows.push(headers.map((header) => escape(doc[header])).join(","));
  }
  return rows.join("\n");
};

const withDatabase = async (dbPath, handler) => {
  const resolved = path.resolve(process.cwd(), dbPath);
  const db = await JsonDatabase.open({ path: resolved, autosave: false });
  try {
    return await handler(db);
  } finally {
    await db.close();
  }
};

const commands = {
  async list(dbPath) {
    await withDatabase(dbPath, async (db) => {
      const collections = db.listCollections();
      if (collections.length === 0) {
        stdout.write("No collections found\n");
        return;
      }
      for (const name of collections) {
        stdout.write(`${name}\n`);
      }
    });
  },

  async stats(dbPath) {
    await withDatabase(dbPath, async (db) => {
      const stats = await db.stats();
      stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    });
  },

  async dump(dbPath, collectionName, opts) {
    await withDatabase(dbPath, async (db) => {
      const collection = db.collection(collectionName);
      const limit = Number(opts.limit ?? 20);
      const filter = parseJson(opts.filter, {});

      const documents = await collection.find(filter, { limit });
      stdout.write(`${JSON.stringify(documents, null, 2)}\n`);
    });
  },

  async export(dbPath, collectionName, opts) {
    await withDatabase(dbPath, async (db) => {
      const collection = db.collection(collectionName);
      const limit = opts.limit ? Number(opts.limit) : undefined;
      const filter = parseJson(opts.filter, {});
      const format = (opts.format || "json").toLowerCase();
      const outFile = opts.out;

      const documents = await collection.find(filter, {
        limit: Number.isFinite(limit) ? limit : undefined,
      });

      let output;
      if (format === "csv") {
        output = documentsToCsv(documents);
      } else {
        output = JSON.stringify(documents, null, 2);
      }

      if (outFile) {
        const fs = require("fs/promises");
        const resolved = path.resolve(process.cwd(), outFile);
        await fs.writeFile(resolved, output, "utf8");
      } else {
        stdout.write(`${output}\n`);
      }
    });
  },
};

const main = async () => {
  const [, , command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    usage();
    exit(command ? 0 : 1);
    return;
  }

  const { options, positional } = parseOptions(rest);

  try {
    switch (command) {
      case "list":
        if (positional.length < 1) throw new Error("list requires <path>");
        await commands.list(positional[0]);
        break;
      case "stats":
        if (positional.length < 1) throw new Error("stats requires <path>");
        await commands.stats(positional[0]);
        break;
      case "dump":
        if (positional.length < 2) {
          throw new Error("dump requires <path> and <collection>");
        }
        await commands.dump(positional[0], positional[1], options);
        break;
      case "export":
        if (positional.length < 2) {
          throw new Error("export requires <path> and <collection>");
        }
        await commands.export(positional[0], positional[1], options);
        break;
      default:
        throw new Error(`Unknown command "${command}"`);
    }
  } catch (error) {
    stderr.write(`${error.message}\n`);
    usage();
    exit(1);
    return;
  }
};

main().catch((error) => {
  stderr.write(`${error.stack || error.message}\n`);
  exit(1);
});
