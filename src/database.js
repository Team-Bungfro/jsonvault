"use strict";

const path = require("path");
const JsonCollection = require("./collection");
const FileStorageAdapter = require("./storage/fileStorageAdapter");
const debounce = require("./utils/debounce");
const { cloneDeep } = require("./utils/objectUtils");

const DEFAULT_OPTIONS = {
  path: path.resolve(process.cwd(), "json-storage"),
  autosave: true,
  autosaveInterval: 750,
};

class JsonDatabase {
  constructor(options = {}) {
    this._options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };

    this._storage =
      options.storage ||
      new FileStorageAdapter({ directory: this._options.path });

    this._collections = new Map();
    this._dirtyCollections = new Set();
    this._meta = null;
    this._state = "closed";

    this._autosave = debounce(() => this.save(), this._options.autosaveInterval);
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

  async _notifyChange(collection) {
    this._dirtyCollections.add(collection.name);
    this._scheduleAutosave();
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
}

module.exports = JsonDatabase;
