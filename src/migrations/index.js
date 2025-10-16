"use strict";

const fs = require("fs/promises");
const path = require("path");
const {
  AlreadyExistsError,
  InvalidArgumentError,
  NotFoundError,
  InvalidOperationError,
} = require("../errors");

const SUPPORTED_EXTENSIONS = new Set([".js", ".cjs"]);

const compareMigrationId = (a, b) =>
  String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });

const normalizeDirectory = (directory) => {
  if (!directory) {
    return path.resolve(process.cwd(), "migrations");
  }
  return path.resolve(directory);
};

const pad = (value) => String(value).padStart(2, "0");

const formatTimestampId = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
};

const sanitizeName = (input) => {
  if (!input || typeof input !== "string") {
    return "";
  }
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const buildMigrationId = (name) => {
  const base = sanitizeName(name);
  const timestamp = formatTimestampId();
  return base ? `${timestamp}-${base}` : timestamp;
};

const defaultTemplate = (id) => `"use strict";

module.exports = {
  async up(db) {
    // TODO: add migration logic for ${id}
  },

  async down(db) {
    // TODO: reverse migration logic for ${id}
  },
};
`;

const createMigration = async (options = {}) => {
  const targetDir = normalizeDirectory(options.directory);
  const name = options.name || "migration";
  const id = buildMigrationId(name);
  const filename = `${id}.js`;
  const filePath = path.join(targetDir, filename);

  await fs.mkdir(targetDir, { recursive: true });

  try {
    await fs.access(filePath);
    throw new AlreadyExistsError(`Migration "${filename}" already exists in ${targetDir}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const template =
    typeof options.template === "function"
      ? options.template(id)
      : defaultTemplate(id);

  await fs.writeFile(filePath, template, "utf8");
  return { id, file: filePath };
};

const hydrateModule = (filePath) => {
  delete require.cache[filePath];
  const raw = require(filePath);
  return raw && raw.default ? raw.default : raw;
};

const toMigrationRecord = (entry, filePath) => {
  const fallbackId = path.parse(filePath).name;
  let up;
  let down;
  let id = fallbackId;
  let description = null;

  if (typeof entry === "function") {
    up = entry;
    down = typeof entry.down === "function" ? entry.down : undefined;
    id = entry.id || fallbackId;
    description =
      entry.description !== undefined ? entry.description : entry.name || null;
  } else if (entry && typeof entry === "object") {
    up = entry.up;
    down = entry.down;
    id = entry.id || fallbackId;
    description =
      entry.description !== undefined ? entry.description : null;
  }

  if (typeof up !== "function") {
    throw new InvalidArgumentError(
      `Migration "${path.basename(filePath)}" must export an up() function`,
    );
  }

  if (down && typeof down !== "function") {
    throw new InvalidArgumentError(
      `Migration "${path.basename(filePath)}" exports down but it is not a function`,
    );
  }

  return {
    id: String(id),
    file: filePath,
    description: description === undefined ? null : description,
    up,
    down,
  };
};

const loadMigrations = async (directory) => {
  const targetDir = normalizeDirectory(directory);
  let dirEntries = [];
  try {
    dirEntries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const migrations = [];
  for (const entry of dirEntries) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name);
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      continue;
    }
    const filePath = path.join(targetDir, entry.name);
    const moduleEntry = hydrateModule(filePath);
    const migration = toMigrationRecord(moduleEntry, filePath);
    migrations.push(migration);
  }

  migrations.sort((a, b) => compareMigrationId(a.id, b.id));
  return migrations;
};

const selectPendingMigrations = (allMigrations, appliedIds) =>
  allMigrations.filter((migration) => !appliedIds.has(migration.id));

const planMigrateUp = (pending, options = {}) => {
  const plan = [...pending];
  if (options.to) {
    const index = plan.findIndex((migration) => migration.id === options.to);
    if (index === -1) {
      throw new NotFoundError(`Migration "${options.to}" not found or already applied`);
    }
    return plan.slice(0, index + 1);
  }
  if (options.step !== undefined) {
    const step = Number(options.step);
    if (!Number.isInteger(step) || step <= 0) {
      throw new InvalidArgumentError("step must be a positive integer");
    }
    return plan.slice(0, step);
  }
  return plan;
};

const planMigrateDown = (applied, migrations, options = {}) => {
  if (applied.length === 0) {
    return { plan: [], targetSeen: !options.to };
  }

  const map = new Map(migrations.map((migration) => [migration.id, migration]));
  const plan = [];
  let targetSeen = !options.to;
  const step = options.step === undefined ? undefined : Number(options.step);

  if (step !== undefined) {
    if (!Number.isInteger(step) || step <= 0) {
      throw new InvalidArgumentError("step must be a positive integer");
    }
  }

  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const entry = applied[i];
    if (options.to && entry.id === options.to) {
      targetSeen = true;
      break;
    }

    const migration = map.get(entry.id);
    if (!migration) {
      throw new NotFoundError(`Migration definition for "${entry.id}" is missing`);
    }
    if (typeof migration.down !== "function") {
      throw new InvalidOperationError(`Migration "${entry.id}" does not define a down() function`);
    }
    plan.push(migration);

    if (step !== undefined && plan.length >= step) {
      break;
    }
  }

  return { plan, targetSeen };
};

const formatResult = (executed, dryRun) => ({
  ran: executed.map((migration) => ({
    id: migration.id,
    description: migration.description || null,
  })),
  dryRun,
});

const migrateUp = async (db, options = {}) => {
  const migrations = await loadMigrations(options.directory);
  const applied = db.getAppliedMigrations();
  const appliedIds = new Set(applied.map((entry) => entry.id));
  const pending = selectPendingMigrations(migrations, appliedIds);

  const plan = planMigrateUp(pending, options);
  if (plan.length === 0) {
    return formatResult([], Boolean(options.dryRun));
  }

  if (options.dryRun) {
    return formatResult(plan, true);
  }

  const executed = [];
  for (const migration of plan) {
    await db.transaction(async (session) => migration.up(session));
    await db.recordMigrationApplied(migration.id, {
      description: migration.description || null,
    });
    executed.push(migration);
  }

  return formatResult(executed, false);
};

const migrateDown = async (db, options = {}) => {
  const migrations = await loadMigrations(options.directory);
  const applied = db.getAppliedMigrations();
  const { plan, targetSeen } = planMigrateDown(applied, migrations, options);

  if (options.to && !targetSeen) {
    throw new InvalidArgumentError(`Applied migrations do not include "${options.to}"`);
  }

  if (plan.length === 0) {
    return formatResult([], Boolean(options.dryRun));
  }

  if (options.dryRun) {
    return formatResult(plan, true);
  }

  const executed = [];
  for (const migration of plan) {
    await db.transaction(async (session) => migration.down(session));
    await db.recordMigrationReverted(migration.id);
    executed.push(migration);
  }

  return formatResult(executed, false);
};

const migrationStatus = async (db, options = {}) => {
  const migrations = await loadMigrations(options.directory);
  const appliedEntries = db.getAppliedMigrations();
  const appliedMap = new Map(migrations.map((migration) => [migration.id, migration]));

  const applied = appliedEntries.map((entry) => {
    const description =
      entry.description !== undefined && entry.description !== null
        ? entry.description
        : appliedMap.get(entry.id)?.description || null;
    return {
      id: entry.id,
      appliedAt: entry.appliedAt,
      description,
    };
  });

  const appliedIds = new Set(appliedEntries.map((entry) => entry.id));
  const pending = migrations
    .filter((migration) => !appliedIds.has(migration.id))
    .map((migration) => ({
      id: migration.id,
      description: migration.description || null,
    }));

  return { applied, pending };
};

module.exports = {
  loadMigrations,
  migrateUp,
  migrateDown,
  migrationStatus,
  createMigration,
};
