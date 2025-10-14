"use strict";

const path = require("path");
const EventEmitter = require("events");
const JsonCollection = require("./collection");
const FileStorageAdapter = require("./storage/fileStorageAdapter");
const { getAdapter } = require("./adapters");
const debounce = require("./utils/debounce");
const { cloneDeep } = require("./utils/objectUtils");

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
        throw new Error(
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
  }

  static async open(options = {}) {
    const database = new JsonDatabase(options);
    await database._init();
    return database;
  }

  async _init() {
    await this._storage.init();
    this._meta = await this._storage.readMeta();
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
    this._emitChange(collection, change);
  }

  watch(pattern = "**") {
    const regex = this._patternToRegex(pattern);
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);

    const entry = { pattern, regex, emitter };
    emitter.close = () => {
      this._watchers.delete(entry);
    };

    this._watchers.add(entry);
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
    if (!this._watchers || this._watchers.size === 0) {
      return;
    }

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

    for (const watcher of this._watchers) {
      if (event.paths.some((path) => watcher.regex.test(path))) {
        watcher.emitter.emit("change", { ...event });
      }
    }
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
    await this._storage.writeMeta(this._meta);
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
      throw new Error("snapshot() expects an object created by JsonDatabase.snapshot()");
    }

    const collections = snapshot.collections || {};
    const meta = snapshot.meta || {};

    this._meta = {
      ...this._meta,
      ...meta,
    };

    await this._restoreSnapshot(collections);
    await this._storage.writeMeta(this._meta);

    for (const collection of this._collections.values()) {
      this._emitChange(collection, { type: "restore" });
    }
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
