"use strict";

const path = require("path");
const EventEmitter = require("events");
const { AsyncLocalStorage } = require("node:async_hooks");

const JsonCollection = require("./collection");
const FileStorageAdapter = require("./storage/fileStorageAdapter");
const { getAdapter } = require("./adapters");
const { compileQuery } = require("./query/compiler");
const debounce = require("./utils/debounce");
const { cloneDeep } = require("./utils/objectUtils");
const { runSql, runSqlBatch } = require("./sql/sqlEngine");
const FileChangeLog = require("./changelog/fileChangeLog");
const {
  PolicyDeniedError,
  InvalidArgumentError,
} = require("./errors");

const debugWatch = (...parts) => {
  if (process.env.JSONVAULT_DEBUG_WATCH) {
    // eslint-disable-next-line no-console
    console.log("[jsonvault:watch]", ...parts);
  }
};

const DEFAULT_OPTIONS = {
  path: path.resolve(process.cwd(), "json-storage"),
  autosave: true,
  autosaveInterval: 750,
  ttlIntervalMs: 60_000,
};

class JsonDatabase {
  constructor(options = {}) {
    this._options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };

    if (options.storage) {
      this._storage = options.storage;
    } else {
      const adapterName = options.adapter || "json";
      const adapterFactory = getAdapter(adapterName);

      if (!adapterFactory) {
        throw new InvalidArgumentError(
          `Unknown adapter "${adapterName}". Register it with registerAdapter().`,
        );
      }

      const adapterOptions = {
        directory: this._options.path,
        ...(options.adapterOptions || {}),
      };

      this._storage = adapterFactory(adapterOptions);
    }

    this._collections = new Map();
    this._dirtyCollections = new Set();
    this._meta = null;
    this._state = "closed";

    this._autosave = debounce(() => this.save(), this._options.autosaveInterval);
    this._ttlTimer = null;
    this._ttlRunning = false;
    this._watchers = new Set();
    this._fsWatcherCleanup = null;
    this._changeLog = null;
    this._contextStore = new AsyncLocalStorage();
    this._policies = new Map();
  }

  static async open(options = {}) {
    const database = new JsonDatabase(options);
    await database._init();
    return database;
  }

  async _init() {
    await this._storage.init();
    this._meta = this._normalizeMeta(await this._storage.readMeta());
    await this._initChangeLog();
    const collections = await this._storage.listCollections();

    for (const name of collections) {
      const payload = await this._storage.readCollection(name);
      this._createCollection(name, payload.documents, payload.indexes, payload.options);
    }

    this._state = "ready";
    this._startTtlTimer();
  }

  _createCollection(name, documents = [], indexes = {}, options = {}, runtime = {}) {
    const collection = new JsonCollection({
      name,
      database: this,
      documents,
      indexes,
      options,
      runtime,
    });

    this._collections.set(name, collection);
    return collection;
  }

  _normalizeMeta(meta = {}) {
    const normalized = {
      migrations: { applied: [] },
      ...meta,
    };

    if (
      !normalized.migrations ||
      !Array.isArray(normalized.migrations.applied)
    ) {
      normalized.migrations = { applied: [] };
    }

    return normalized;
  }

  async _initChangeLog() {
    const spec = this._options.changeLog;
    if (!spec) {
      return;
    }

    const basePath = this._options.path;
    const config = typeof spec === "object" ? { ...spec } : {};

    const directory =
      config.directory || path.join(basePath, "changelog");
    const file =
      config.path || path.join(directory, "log.jsonl");

    const changeLogOptions = {
      file,
      maxEntries: config.maxEntries,
      maxSize: config.maxSize,
      autoArchive: config.autoArchive,
      archiveDirectory: config.archiveDirectory,
    };

    this._changeLog = await FileChangeLog.create(changeLogOptions);
  }

  get changeLog() {
    return this._changeLog;
  }

  getContext() {
    return this._contextStore.getStore() || null;
  }

  with(context = {}) {
    const baseContext = { ...(this.getContext() || {}), ...context };
    const database = this;

    const handler = {
      get(target, prop) {
        if (typeof prop === "symbol") {
          return Reflect.get(target, prop);
        }
        if (prop === "with") {
          return (child = {}) =>
            database.with({ ...baseContext, ...child });
        }
        const value = target[prop];
        if (typeof value === "function") {
          return (...args) =>
            database._contextStore.run(baseContext, () => {
              const result = value.apply(target, args);
              return database._wrapResultWithContext(result, baseContext);
            });
        }
        return database._wrapResultWithContext(value, baseContext);
      },
    };

    return new Proxy(this, handler);
  }

  policy(collectionName, definition = {}) {
    if (!collectionName || typeof collectionName !== "string") {
      throw new InvalidArgumentError(
        "policy(collection, definition) requires a collection name",
      );
    }
    if (!definition || typeof definition !== "object") {
      throw new InvalidArgumentError(
        "policy(collection, definition) requires a definition object",
      );
    }

    const normalized = this._normalizePolicy(definition);
    this._policies.set(collectionName, normalized);
  }

  async get(documentPath) {
    if (!documentPath || typeof documentPath !== "string") {
      throw new InvalidArgumentError(
        "get(path) requires a document path (collection/id)",
      );
    }
    const parts = documentPath.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new InvalidArgumentError(
        "Document path must be in the form collection/id",
      );
    }
    const [collection, ...rest] = parts;
    const id = rest.join("/");
    if (!id) {
      throw new InvalidArgumentError("Document path must include an id");
    }
    const coll = this.collection(collection);
    return coll.findById(id);
  }

  _getPolicy(collectionName) {
    return this._policies.get(collectionName) || null;
  }

  _normalizePolicy(definition) {
    const asyncWrap = (fn, fallback) => {
      if (typeof fn !== "function") {
        return fallback;
      }
      return async (payload) => fn(payload);
    };

    const read = asyncWrap(
      definition.read,
      async () => true,
    );
    const write = asyncWrap(
      definition.write,
      async () => true,
    );
    const redact = asyncWrap(
      definition.redact,
      async ({ row }) => cloneDeep(row),
    );

    return { read, write, redact };
  }

  async _allowRead(collectionName, row) {
    const policy = this._getPolicy(collectionName);
    if (!policy) {
      return true;
    }
    const ctx = this.getContext();
    const payload = { row: cloneDeep(row), ctx: ctx ? { ...ctx } : null };
    return Boolean(await policy.read(payload));
  }

  async _redactRow(collectionName, row) {
    const policy = this._getPolicy(collectionName);
    if (!policy) {
      return cloneDeep(row);
    }
    const ctx = this.getContext();
    const payload = { row: cloneDeep(row), ctx: ctx ? { ...ctx } : null };
    const result = await policy.redact(payload);
    if (result === undefined || result === null) {
      return null;
    }
    return cloneDeep(result);
  }

  async _enforceWritePolicy(collectionName, operation, previous, next) {
    const policy = this._getPolicy(collectionName);
    if (!policy) {
      return;
    }
    const ctx = this.getContext();
    const payload = {
      operation,
      previous: previous == null ? null : cloneDeep(previous),
      next: next == null ? null : cloneDeep(next),
      ctx: ctx ? { ...ctx } : null,
    };
    const allowed = await policy.write(payload);
    if (!allowed) {
      throw new PolicyDeniedError(
        `Policy denied ${operation} on collection "${collectionName}"`,
        { collection: collectionName, operation, ctx: payload.ctx },
      );
    }
  }

  _wrapResultWithContext(value, context) {
    if (value instanceof JsonCollection) {
      return this._wrapCollectionWithContext(value, context);
    }
    return value;
  }

  _wrapCollectionWithContext(collection, context) {
    const database = this;
    return new Proxy(collection, {
      get(target, prop) {
        if (typeof prop === "symbol") {
          return Reflect.get(target, prop);
        }
        const value = target[prop];
        if (typeof value === "function") {
          return (...args) =>
            database._contextStore.run(context, () =>
              value.apply(target, args),
            );
        }
        return value;
      },
    });
  }

  getAppliedMigrations() {
    const applied = this._meta?.migrations?.applied;
    if (!Array.isArray(applied)) {
      return [];
    }
    return applied.map((entry) => ({ ...entry }));
  }

  async recordMigrationApplied(id, info = {}) {
    const applied = this.getAppliedMigrations();
    if (applied.some((entry) => entry.id === id)) {
      return;
    }

    const appliedAt = info.appliedAt || new Date().toISOString();
    applied.push({
      id,
      appliedAt,
      description:
        info.description === undefined ? null : info.description,
    });

    const nextMeta = {
      ...this._meta,
      migrations: { applied },
    };

    this._meta = this._normalizeMeta(await this._storage.writeMeta(nextMeta));
  }

  async recordMigrationReverted(id) {
    const applied = this.getAppliedMigrations().filter(
      (entry) => entry.id !== id,
    );

    const nextMeta = {
      ...this._meta,
      migrations: { applied },
    };

    this._meta = this._normalizeMeta(await this._storage.writeMeta(nextMeta));
  }

  collection(name, runtime = {}) {
    if (!this._collections.has(name)) {
      const collection = this._createCollection(
        name,
        [],
        {},
        { primaryKey: runtime.primaryKey },
        runtime,
      );
      this._dirtyCollections.add(name);
      this._scheduleAutosave();
      return collection;
    }

    const collection = this._collections.get(name);
    if (runtime.validator || runtime.hooks) {
      collection._runtime = {
        validator: runtime.validator || collection._runtime.validator,
        hooks: { ...collection._runtime.hooks, ...runtime.hooks },
      };
    }

    if (Object.prototype.hasOwnProperty.call(runtime, "schema")) {
      collection.setSchema(runtime.schema);
    }

    if (Object.prototype.hasOwnProperty.call(runtime, "encryption")) {
      collection.setEncryption(runtime.encryption);
    }

    return collection;
  }

  listCollections() {
    return Array.from(this._collections.keys());
  }

  async dropCollection(name) {
    const collection = this._collections.get(name);
    if (!collection) {
      return;
    }

    this._collections.delete(name);
    this._dirtyCollections.delete(name);
    await this._storage.deleteCollection(name);
  }

  async _notifyChange(collection, change = {}) {
    this._dirtyCollections.add(collection.name);
    this._scheduleAutosave();
    const event = this._emitChange(collection, change);
    await this._appendChangeLog(event);
  }

  watch(pattern = "**") {
    const regex = this._patternToRegex(pattern);
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);

    const entry = { pattern, regex, emitter };
    emitter.close = () => {
      this._watchers.delete(entry);
      debugWatch("watch removed", pattern, "remaining", this._watchers.size);
      if (this._watchers.size === 0) {
        this._stopFsWatcher();
      }
    };

    this._watchers.add(entry);
    this._ensureFsWatcher();
    debugWatch("watch added", pattern, "total", this._watchers.size);
    return emitter;
  }

  _patternToRegex(pattern) {
    if (!pattern || pattern === "**") {
      return /^.*$/;
    }

    const escape = (segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const parts = pattern.split("/").map((segment) => {
      if (segment === "**") {
        return ".*";
      }
      if (segment === "*") {
        return "[^/]+";
      }
      return escape(segment);
    });

    return new RegExp(`^${parts.join("/")}$`);
  }

  _emitChange(collection, change) {
    const event = {
      collection: collection.name,
      primaryKey: collection.primaryKey,
      timestamp: new Date().toISOString(),
      ...change,
    };

    const paths = new Set([collection.name]);

    const appendFromDocs = (docs) => {
      if (!Array.isArray(docs)) return;
      for (const doc of docs) {
        if (!doc || typeof doc !== "object") continue;
        const id = doc[collection.primaryKey];
        if (id !== undefined) {
          paths.add(`${collection.name}/${id}`);
        }
      }
    };

    appendFromDocs(event.documents);
    if (Array.isArray(event.updates)) {
      appendFromDocs(event.updates.map((entry) => entry.next));
      appendFromDocs(event.updates.map((entry) => entry.previous));
    }
    appendFromDocs(event.deleted);

    event.paths = Array.from(paths);
    if (this._watchers && this._watchers.size > 0) {
      this._notifyWatchers(paths, event);
    }
    return event;
  }

  _scheduleAutosave() {
    if (this._options.autosave) {
      this._autosave();
    }
  }

  async save() {
    if (this._dirtyCollections.size === 0) {
      return;
    }

    for (const name of this._dirtyCollections) {
      const collection = this._collections.get(name);
      if (!collection) {
        continue;
      }
      await this._storage.writeCollection(name, collection.toJSON());
    }

    this._dirtyCollections.clear();
    this._meta.updatedAt = new Date().toISOString();
    this._meta = this._normalizeMeta(await this._storage.writeMeta(this._meta));
  }

  _notifyWatchers(paths, event) {
    if (!this._watchers || this._watchers.size === 0) {
      return;
    }

    const list = Array.from(paths);
    const payload = { ...event, paths: list };
    debugWatch("notify", payload);

    for (const watcher of this._watchers) {
      if (list.some((path) => watcher.regex.test(path))) {
        watcher.emitter.emit("change", { ...payload });
      }
    }
  }

  async _appendChangeLog(event) {
    if (!this._changeLog || !event) {
      return;
    }

    try {
      await this._changeLog.append(cloneDeep(event));
    } catch (error) {
      if (process.env.JSONVAULT_DEBUG_WATCH) {
        // eslint-disable-next-line no-console
        console.error("[jsonvault:changelog] append failed", error);
      }
    }
  }

  _ensureFsWatcher() {
    if (this._fsWatcherCleanup || typeof this._storage.watch !== "function") {
      return;
    }

    try {
      this._fsWatcherCleanup = this._storage.watch((event) => {
        this._emitExternalChange(event);
      });
      debugWatch("fs watcher attached");
    } catch (error) {
      debugWatch("fs watcher failed", error.message);
      this._fsWatcherCleanup = null;
    }
  }

  _stopFsWatcher() {
    if (!this._fsWatcherCleanup) {
      return;
    }
    try {
      this._fsWatcherCleanup();
    } catch (error) {
      // ignore
    }
    this._fsWatcherCleanup = null;
    debugWatch("fs watcher removed");
  }

  _emitExternalChange(event) {
    if (!event) {
      return;
    }

    debugWatch("external event", event);

    const paths = new Set();
    let collection = null;

    if (event.filename) {
      const filename = String(event.filename);
      const collectionMatch = filename.match(/^(.*)\.collection\./);
      if (collectionMatch) {
        collection = collectionMatch[1];
        paths.add(collection);
      }

      const chunkMatch = filename.match(/^(.*)\.chunk-/);
      if (!collection && chunkMatch) {
        collection = chunkMatch[1];
        paths.add(collection);
      }

      paths.add(filename);
    }

    if (paths.size === 0) {
      paths.add("external");
    }

    const payload = {
      type: "external",
      source: "filesystem",
      collection,
      timestamp: new Date().toISOString(),
      event,
    };

    this._notifyWatchers(paths, payload);
  }

  _notifyWatchers(paths, event) {
    if (!this._watchers || this._watchers.size === 0) {
      return;
    }

    const list = Array.from(paths);
    const payload = { ...event, paths: list };

    for (const watcher of this._watchers) {
      if (list.some((path) => watcher.regex.test(path))) {
        watcher.emitter.emit("change", { ...payload });
      }
    }
  }

  _ensureFsWatcher() {
    if (this._fsWatcherCleanup || typeof this._storage.watch !== "function") {
      return;
    }

    try {
      this._fsWatcherCleanup = this._storage.watch((event) => {
        this._emitExternalChange(event);
      });
    } catch (error) {
      this._fsWatcherCleanup = null;
    }
  }

  _stopFsWatcher() {
    if (!this._fsWatcherCleanup) {
      return;
    }
    try {
      this._fsWatcherCleanup();
    } catch (error) {
      // ignore
    }
    this._fsWatcherCleanup = null;
  }

  _emitExternalChange(event) {
    if (!event) {
      return;
    }

    const paths = new Set();
    let collection = null;

    if (event.filename) {
      const filename = String(event.filename);
      const collectionMatch = filename.match(/^(.*)\.collection\./);
      if (collectionMatch) {
        collection = collectionMatch[1];
        paths.add(collection);
      }

      const chunkMatch = filename.match(/^(.*)\.chunk-/);
      if (!collection && chunkMatch) {
        collection = chunkMatch[1];
        paths.add(collection);
      }

      paths.add(filename);
    }

    if (paths.size === 0) {
      paths.add("external");
    }

    const payload = {
      type: "external",
      source: "filesystem",
      collection,
      timestamp: new Date().toISOString(),
      event,
    };

    this._notifyWatchers(paths, payload);
  }

  async backup(destination) {
    return this._storage.backup(destination);
  }

  async purgeExpired() {
    await this._runTtlMaintenance();
  }

  async compact() {
    await this.save();
  }

  async snapshot() {
    await this._autosave.flush();
    const collections = this._createSnapshot();
    const meta = cloneDeep(this._meta);
    return {
      meta,
      collections,
    };
  }

  async restore(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new InvalidArgumentError(
        "snapshot() expects an object created by JsonDatabase.snapshot()",
      );
    }

    const collections = snapshot.collections || {};
    const meta = snapshot.meta || {};

    this._meta = this._normalizeMeta({
      ...this._meta,
      ...meta,
    });

    await this._restoreSnapshot(collections);
    this._meta = this._normalizeMeta(await this._storage.writeMeta(this._meta));

    for (const collection of this._collections.values()) {
      this._emitChange(collection, { type: "restore" });
    }
  }

  compile(input) {
    return compileQuery(input);
  }

  stream(compiled, options = {}) {
    if (!compiled || typeof compiled.execute !== "function") {
      throw new InvalidArgumentError(
        "db.stream requires a compiled query from db.compile()",
      );
    }
    return compiled.execute(this, options);
  }

  sql(strings, ...values) {
    return runSql(this, strings, ...values);
  }

  sqlBatch(strings, ...values) {
    return this.transaction((db) => runSqlBatch(db, strings, ...values));
  }

  async transaction(callback) {
    const snapshot = this._createSnapshot();

    try {
      const result = await callback(this);
      await this.save();
      return result;
    } catch (error) {
      await this._restoreSnapshot(snapshot);
      throw error;
    }
  }

  _createSnapshot() {
    const snapshot = {};
    for (const [name, collection] of this._collections.entries()) {
      snapshot[name] = cloneDeep(collection.toJSON());
    }
    return snapshot;
  }

  async _restoreSnapshot(snapshot) {
    const names = new Set(Object.keys(snapshot));

    for (const [name, payload] of Object.entries(snapshot)) {
      if (this._collections.has(name)) {
        const collection = this._collections.get(name);
        collection.hydrateFromSnapshot(
          payload.documents,
          payload.indexes,
          payload.options,
        );
      } else {
        this._createCollection(
          name,
          payload.documents,
          payload.indexes,
          payload.options,
        );
      }
    }

    for (const name of Array.from(this._collections.keys())) {
      if (!names.has(name)) {
        this._collections.delete(name);
      }
    }

    this._dirtyCollections.clear();
  }

  async close() {
    await this._autosave.flush();
    await this.save();
    this._stopTtlTimer();
    if (this._changeLog) {
      await this._changeLog.close();
    }
    this._state = "closed";
  }

  async stats() {
    const collections = Array.from(this._collections.values()).map((collection) =>
      collection.getStats(),
    );

    return {
      path: this._options.path,
      collections,
      totalDocuments: collections.reduce((sum, entry) => sum + entry.count, 0),
    };
  }

  _startTtlTimer() {
    if (this._options.ttlIntervalMs <= 0 || this._ttlTimer) {
      return;
    }

    this._ttlTimer = setInterval(() => {
      this._runTtlMaintenance().catch((error) => {
        console.error("[JsonDatabase] TTL maintenance failed:", error);
      });
    }, this._options.ttlIntervalMs);

    if (typeof this._ttlTimer.unref === "function") {
      this._ttlTimer.unref();
    }
  }

  _stopTtlTimer() {
    if (this._ttlTimer) {
      clearInterval(this._ttlTimer);
      this._ttlTimer = null;
    }
  }

  async _runTtlMaintenance() {
    if (this._ttlRunning) {
      return;
    }

    this._ttlRunning = true;
    const now = Date.now();

    try {
      for (const collection of this._collections.values()) {
        if (!collection._hasTtlIndexes()) {
          continue;
        }

        try {
          await collection._purgeExpiredDocuments(now);
        } catch (error) {
          console.error(
            `[JsonDatabase] TTL sweep failed for collection "${collection.name}":`,
            error,
          );
        }
      }
    } finally {
      this._ttlRunning = false;
    }
  }
}

module.exports = JsonDatabase;
