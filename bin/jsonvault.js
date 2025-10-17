#!/usr/bin/env node
"use strict";

const path = require("path");
const { stdout, stderr, exit, argv } = process;
const fs = require("fs/promises");
const crypto = require("crypto");

const { JsonDatabase } = require("../src");
const {
  InvalidArgumentError,
  NotFoundError,
  InvalidOperationError,
} = require("../src/errors");
const migrationApi = require("../src/migrations");

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
      "  put <path> <json>            Upsert a document (collection/id)",
      "  get <path>                  Fetch a document by id",
      "  snapshot <path>             Write a database snapshot",
      "  migrate <path> [action]     Run migrations (actions: up, down, status, create)",
      "  changelog tail <path>       Print recent change log entries",
      "  query <path> <sql>          Run a SQL/JSONPath query and print results",
      "",
      "Global options:",
      "  --config=<file>              Load CLI defaults (path, adapter, etc.)",
      "",
      "Options for dump:",
      "  --limit=<n>                  Limit number of documents (default: 20)",
      "  --filter=<json>              JSON filter object",
      "  --adapter=<name>             Choose adapter (json, yaml, ...)",
      "  --adapterOptions=<json>      Adapter-specific options",
      "",
      "Options for export:",
      "  --limit=<n>                  Limit number of documents",
      "  --filter=<json>              JSON filter object",
      "  --format=<json|csv>          Output format (default json)",
      "  --out=<path>                 Write to file instead of stdout",
      "",
      "Options for snapshot:",
      "  --label=<name>               Snapshot label (default timestamp)",
      "  --sign                      Write SHA256 signature",
      "",
      "Options for migrate:",
      "  --dir=<path>                 Directory with migration files (default ./migrations)",
      "  --to=<id>                    Stop at migration id",
      "  --step=<n>                   Number of migrations to apply/rollback",
      "  --dryRun                     Show the plan without executing",
      "  --json                       Print status output as JSON",
      "",
      "Options for changelog tail:",
      "  --limit=<n>                  Maximum entries to print (default 50)",
      "  --from=<seq>                 Resume from sequence id",
      "  --log=<path>                Override change log file path",
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
    throw new InvalidArgumentError(`Failed to parse JSON: ${value}`);
  }
};

const loadConfig = async (configPath) => {
  if (!configPath) {
    return {};
  }

  const resolved = path.resolve(process.cwd(), configPath);
  let contents;
  try {
    contents = await fs.readFile(resolved, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new NotFoundError(`Config file not found: ${configPath}`);
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new InvalidArgumentError(`Failed to parse config "${configPath}": ${error.message}`);
  }

  const rootDir = path.dirname(resolved);
  const normalize = (maybePath) => {
    if (!maybePath || typeof maybePath !== "string") {
      return maybePath;
    }
    if (path.isAbsolute(maybePath)) {
      return maybePath;
    }
    return path.resolve(rootDir, maybePath);
  };

  const config = {};

  if (parsed.database && typeof parsed.database === "object") {
    const dbConfig = { ...parsed.database };
    if (dbConfig.path) {
      dbConfig.path = normalize(dbConfig.path);
    }
    if (dbConfig.adapterOptions && typeof dbConfig.adapterOptions === "object") {
      dbConfig.adapterOptions = { ...dbConfig.adapterOptions };
    }
    if (dbConfig.changeLog && typeof dbConfig.changeLog === "object") {
      const changeLog = { ...dbConfig.changeLog };
      if (changeLog.path) {
        changeLog.path = normalize(changeLog.path);
      }
      if (changeLog.directory) {
        changeLog.directory = normalize(changeLog.directory);
      }
      if (changeLog.archiveDirectory) {
        changeLog.archiveDirectory = normalize(changeLog.archiveDirectory);
      }
      dbConfig.changeLog = changeLog;
    }
    config.database = dbConfig;
  }

  if (parsed.migrations && typeof parsed.migrations === "object") {
    const migrationsConfig = { ...parsed.migrations };
    if (migrationsConfig.directory) {
      migrationsConfig.directory = normalize(migrationsConfig.directory);
    }
    config.migrations = migrationsConfig;
  }

  return config;
};

const resolveDbPathArg = (positional, defaultPath, requiredExtras = 0) => {
  if (defaultPath && positional && positional.length <= requiredExtras) {
    return { path: defaultPath, consumed: 0 };
  }

  if (!positional || positional.length === 0) {
    return { path: defaultPath || null, consumed: 0 };
  }

  return { path: positional[0], consumed: 1 };
};

const buildDbOptions = (opts = {}, config = {}) => {
  const {
    path: _ignoredPath,
    adapter: configAdapter,
    adapterOptions: configAdapterOptions,
    changeLog: configChangeLog,
    ...restConfig
  } = config || {};

  const adapterOptions =
    opts.adapterOptions !== undefined
      ? parseJson(opts.adapterOptions, {})
      : configAdapterOptions
        ? { ...configAdapterOptions }
        : undefined;

  const result = { ...restConfig };

  if (opts.adapter || configAdapter) {
    result.adapter = opts.adapter || configAdapter;
  }

  if (adapterOptions !== undefined) {
    result.adapterOptions = adapterOptions;
  }

  if (configChangeLog) {
    result.changeLog = { ...configChangeLog };
  }

  return result;
};

const stripDbOptions = (opts = {}) => {
  const { adapter, adapterOptions, config, ...rest } = opts;
  return rest;
};

const toBoolean = (value) => {
  if (value === undefined) {
    return true;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const parseDocumentPath = (input) => {
  if (!input) {
    throw new InvalidArgumentError("Document path is required (collection/id)");
  }

  const parts = input.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new InvalidArgumentError("Document path must be in the form collection/id");
  }

  const collection = parts.shift();
  const id = parts.join("/");

  if (!collection || !id) {
    throw new InvalidArgumentError("Document path must include collection and id");
  }

  return { collection, id };
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

const withDatabase = async (dbPath, dbOptions, handler) => {
  const resolved = path.resolve(process.cwd(), dbPath);
  const { adapter, adapterOptions, ...rest } = dbOptions || {};
  const db = await JsonDatabase.open({
    path: resolved,
    autosave: false,
    adapter,
    adapterOptions,
    ...rest,
  });
  try {
    return await handler(db, resolved);
  } finally {
    await db.close();
  }
};

const commands = {
  async list(dbPath, options) {
    await withDatabase(dbPath, options, async (db) => {
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

  async stats(dbPath, options) {
    await withDatabase(dbPath, options, async (db) => {
      const stats = await db.stats();
      stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    });
  },

  async dump(dbPath, dbOptions, collectionName, opts) {
    await withDatabase(dbPath, dbOptions, async (db) => {
      const collection = db.collection(collectionName);
      const limit = Number(opts.limit ?? 20);
      const filter = parseJson(opts.filter, {});

      const documents = await collection.find(filter, { limit });
      stdout.write(`${JSON.stringify(documents, null, 2)}\n`);
    });
  },

  async export(dbPath, dbOptions, collectionName, opts) {
    await withDatabase(dbPath, dbOptions, async (db) => {
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
        const resolved = path.resolve(process.cwd(), outFile);
        await fs.writeFile(resolved, output, "utf8");
      } else {
        stdout.write(`${output}\n`);
      }
    });
  },

  async put(dbPath, dbOptions, docPath, jsonBody) {
    if (!jsonBody) {
      throw new InvalidArgumentError("put requires a JSON document argument");
    }

    const { collection, id } = parseDocumentPath(docPath);
    let document;
    try {
      document = JSON.parse(jsonBody);
    } catch (error) {
      throw new InvalidArgumentError(`Invalid JSON body: ${error.message}`);
    }

    await withDatabase(dbPath, dbOptions, async (db) => {
      const coll = db.collection(collection);
      const primaryKey = coll.primaryKey;

      if (!Object.prototype.hasOwnProperty.call(document, primaryKey)) {
        document[primaryKey] = id;
      } else if (String(document[primaryKey]) !== String(id)) {
        throw new InvalidArgumentError(
          `Document primary key (${primaryKey}) must match id '${id}'`,
        );
      }

      const existing = await coll.findOne({ [primaryKey]: id });

      if (existing) {
        await coll.replaceOne({ [primaryKey]: id }, document);
        stdout.write(`${JSON.stringify(document, null, 2)}\n`);
      } else {
        const inserted = await coll.insertOne(document);
        stdout.write(`${JSON.stringify(inserted, null, 2)}\n`);
      }
    });
  },

  async get(dbPath, dbOptions, docPath) {
    const { collection, id } = parseDocumentPath(docPath);

    await withDatabase(dbPath, dbOptions, async (db) => {
      const coll = db.collection(collection);
      const primaryKey = coll.primaryKey;
      const document = await coll.findOne({ [primaryKey]: id });

      if (!document) {
        stdout.write("null\n");
        return;
      }

      stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    });
  },

  async snapshot(dbPath, dbOptions, opts = {}) {
    await withDatabase(dbPath, dbOptions, async (db, resolvedPath) => {
      const snapshot = await db.snapshot();

      const labelRaw = opts.label || new Date().toISOString();
      const safeLabel = labelRaw.replace(/[^a-z0-9._-]/gi, "-") || "snapshot";
      const snapshotsDir = path.join(resolvedPath, "snapshots");
      await fs.mkdir(snapshotsDir, { recursive: true });

      const filePath = path.join(snapshotsDir, `${safeLabel}.snapshot.json`);
      const payload = JSON.stringify(snapshot, null, 2);
      await fs.writeFile(filePath, payload, "utf8");

      stdout.write(`Snapshot written to ${filePath}\n`);

      if (toBoolean(opts.sign)) {
        const hash = crypto.createHash("sha256").update(payload).digest("hex");
        const signaturePath = `${filePath}.sha256`;
        await fs.writeFile(signaturePath, `${hash}  ${path.basename(filePath)}\n`, "utf8");
        stdout.write(`Signature written to ${signaturePath}\n`);
      }
    });
  },

  async query(dbPath, dbOptions, sqlText) {
    if (!sqlText) {
      throw new InvalidArgumentError("query requires <sql>");
    }

    await withDatabase(dbPath, dbOptions, async (db) => {
      const results = await db.sql(sqlText);
      stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    });
  },

  async migrate(dbPath, dbOptions, action = "up", opts = {}) {
    const resolvedDbPath = path.resolve(process.cwd(), dbPath);
    const directory =
      opts.dir ||
      opts.directory ||
      path.join(resolvedDbPath, "migrations");
    const toId = opts.to;
    const stepRaw = opts.step;
    const dryRun = opts.dryRun !== undefined ? toBoolean(opts.dryRun) : false;

    if (action === "create") {
      const name = opts.name;
      if (!name) {
        throw new InvalidArgumentError("migrate create requires <name>");
      }
      const result = await migrationApi.createMigration({
        directory,
        name,
      });
      const relativePath = path.relative(process.cwd(), result.file) || result.file;
      stdout.write(`Created migration ${relativePath}\n`);
      return;
    }

    const buildOptions = () => {
      const result = {
        directory,
        to: toId,
        dryRun,
      };
      if (stepRaw !== undefined) {
        const parsed = Number(stepRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new InvalidArgumentError("step must be a positive integer");
        }
        result.step = parsed;
      }
      return result;
    };

    const printList = (heading, rows) => {
      stdout.write(`${heading}\n`);
      if (rows.length === 0) {
        stdout.write("  (none)\n");
        return;
      }
      for (const row of rows) {
        const parts = [];
        if (row.description) {
          parts.push(row.description);
        }
        if (row.appliedAt) {
          parts.push(`applied ${row.appliedAt}`);
        }
        const suffix = parts.length > 0 ? ` - ${parts.join(" | ")}` : "";
        stdout.write(`  ${row.id}${suffix}\n`);
      }
    };

    await withDatabase(dbPath, dbOptions, async (db) => {
      switch (action) {
        case "up": {
          const result = await migrationApi.migrateUp(db, buildOptions());
          if (result.ran.length === 0) {
            stdout.write(result.dryRun ? "No migrations to apply\n" : "Already up to date\n");
          } else {
            const heading = result.dryRun ? "Planned migrations:" : "Applied migrations:";
            printList(heading, result.ran);
          }
          break;
        }
        case "down": {
          const result = await migrationApi.migrateDown(db, buildOptions());
          if (result.ran.length === 0) {
            stdout.write(result.dryRun ? "No migrations to rollback\n" : "No migrations were rolled back\n");
          } else {
            const heading = result.dryRun ? "Migrations to rollback:" : "Rolled back migrations:";
            printList(heading, result.ran);
          }
          break;
        }
        case "status": {
          const jsonOutput = opts.json !== undefined ? toBoolean(opts.json) : false;
          const status = await migrationApi.migrationStatus(db, { directory });
          if (jsonOutput) {
            stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          } else {
            printList("Applied migrations:", status.applied);
            printList("Pending migrations:", status.pending);
          }
          break;
        }
        default:
          throw new InvalidArgumentError(`Unknown migrate action "${action}"`);
      }
    });
  },

  async changelogTail(dbPath, dbOptions, opts = {}) {
    const resolvedLogPath =
      typeof opts.log === "string" && opts.log.length > 0
        ? path.resolve(process.cwd(), opts.log)
        : null;

    const openOptions = {
      ...dbOptions,
      changeLog: resolvedLogPath ? { path: resolvedLogPath } : true,
    };

    await withDatabase(dbPath, openOptions, async (db) => {
      if (!db.changeLog) {
        throw new InvalidOperationError("Change log is not enabled for this database");
      }

      const limitRaw = opts.limit === undefined ? 50 : Number(opts.limit);
      if (!Number.isFinite(limitRaw) || limitRaw <= 0) {
        throw new InvalidArgumentError("limit must be a positive number");
      }

      const readOptions = { limit: limitRaw };
      if (opts.from !== undefined) {
        const fromValue = Number(opts.from);
        if (!Number.isFinite(fromValue) || fromValue < 0) {
          throw new InvalidArgumentError("from must be a non-negative number");
        }
        readOptions.from = fromValue;
      }

      const entries = await db.changeLog.read(readOptions);
      stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
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
    const config = options.config ? await loadConfig(options.config) : {};
    if (options.config !== undefined) {
      delete options.config;
    }

    const dbConfig = config.database || {};
    const migrationsConfig = config.migrations || {};
    const defaultDbPath = dbConfig.path;

    switch (command) {
      case "list": {
        const { path: dbPath } = resolveDbPathArg(positional, defaultDbPath);
        if (!dbPath) throw new InvalidArgumentError("list requires <path>");
        await commands.list(dbPath, buildDbOptions(options, dbConfig));
        break;
      }
      case "stats": {
        const { path: dbPath } = resolveDbPathArg(positional, defaultDbPath);
        if (!dbPath) throw new InvalidArgumentError("stats requires <path>");
        await commands.stats(dbPath, buildDbOptions(options, dbConfig));
        break;
      }
      case "dump": {
        const { path: dbPath, consumed } = resolveDbPathArg(positional, defaultDbPath, 1);
        const remaining = positional.slice(consumed);
        if (!dbPath || remaining.length < 1) {
          throw new InvalidArgumentError("dump requires <path> and <collection>");
        }
        await commands.dump(
          dbPath,
          buildDbOptions(options, dbConfig),
          remaining[0],
          stripDbOptions(options),
        );
        break;
      }
      case "export": {
        const { path: dbPath, consumed } = resolveDbPathArg(positional, defaultDbPath, 1);
        const remaining = positional.slice(consumed);
        if (!dbPath || remaining.length < 1) {
          throw new InvalidArgumentError("export requires <path> and <collection>");
        }
        await commands.export(
          dbPath,
          buildDbOptions(options, dbConfig),
          remaining[0],
          stripDbOptions(options),
        );
        break;
      }
      case "put": {
        const { path: dbPath, consumed } = resolveDbPathArg(positional, defaultDbPath, 2);
        const remaining = positional.slice(consumed);
        if (!dbPath || remaining.length < 2) {
          throw new InvalidArgumentError("put requires <path> and <json>");
        }
        await commands.put(
          dbPath,
          buildDbOptions(options, dbConfig),
          remaining[0],
          remaining.slice(1).join(" "),
        );
        break;
      }
      case "get": {
        const { path: dbPath, consumed } = resolveDbPathArg(positional, defaultDbPath, 1);
        const remaining = positional.slice(consumed);
        if (!dbPath || remaining.length < 1) {
          throw new InvalidArgumentError("get requires <path>");
        }
        await commands.get(
          dbPath,
          buildDbOptions(options, dbConfig),
          remaining[0],
        );
        break;
      }
      case "query": {
        const { path: dbPath, consumed } = resolveDbPathArg(positional, defaultDbPath, 1);
        const remaining = positional.slice(consumed);
        if (!dbPath || remaining.length < 1) {
          throw new InvalidArgumentError("query requires <path> and <sql>");
        }
        await commands.query(
          dbPath,
          buildDbOptions(options, dbConfig),
          remaining.join(" "),
        );
        break;
      }
      case "snapshot": {
        const { path: dbPath } = resolveDbPathArg(positional, defaultDbPath);
        if (!dbPath) {
          throw new InvalidArgumentError("snapshot requires <path>");
        }
        await commands.snapshot(
          dbPath,
          buildDbOptions(options, dbConfig),
          stripDbOptions(options),
        );
        break;
      }
      case "migrate": {
        const migrateActions = new Set(["up", "down", "status", "create"]);
        let dbPath;
        let consumed = 0;
        if (defaultDbPath && (positional.length === 0 || migrateActions.has(positional[0]))) {
          dbPath = defaultDbPath;
        } else {
          const resolved = resolveDbPathArg(positional, defaultDbPath);
          dbPath = resolved.path;
          consumed = resolved.consumed;
        }
        const remaining = positional.slice(consumed);
        if (!dbPath) {
          throw new InvalidArgumentError("migrate requires <path>");
        }
        const migrateAction = remaining[0] || "up";
        const migrateOptions = stripDbOptions(options);
        if (!migrateOptions.dir && !migrateOptions.directory && migrationsConfig.directory) {
          migrateOptions.directory = migrationsConfig.directory;
        }
        if (migrateAction === "create") {
          const nameParts = remaining.slice(1);
          if (nameParts.length === 0) {
            throw new InvalidArgumentError("migrate create requires <name>");
          }
          migrateOptions.name = nameParts.join(" ");
        }
        await commands.migrate(
          dbPath,
          buildDbOptions(options, dbConfig),
          migrateAction,
          migrateOptions,
        );
        break;
      }
      case "changelog": {
        const changelogActions = new Set(["tail"]);
        let dbPath;
        let consumed = 0;
        if (defaultDbPath && (positional.length === 0 || changelogActions.has(positional[0]))) {
          dbPath = defaultDbPath;
        } else {
          const resolved = resolveDbPathArg(positional, defaultDbPath);
          dbPath = resolved.path;
          consumed = resolved.consumed;
        }
        const remaining = positional.slice(consumed);
        if (!dbPath) {
          throw new InvalidArgumentError("changelog requires <path>");
        }
        const action = remaining[0] || "tail";
        if (action !== "tail") {
          throw new InvalidArgumentError(`Unknown changelog action "${action}"`);
        }
        await commands.changelogTail(
          dbPath,
          buildDbOptions(options, dbConfig),
          stripDbOptions(options),
        );
        break;
      }
      default:
        throw new InvalidArgumentError(`Unknown command "${command}"`);
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
