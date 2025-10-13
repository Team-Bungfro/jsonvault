"use strict";

const {
  cloneDeep,
  setByPath,
  unsetByPath,
  getByPath,
} = require("./utils/objectUtils");
const { generateId } = require("./utils/idGenerator");
const { queryDocuments } = require("./query/queryEngine");
const { matchFilter } = require("./query/operators");
const IndexManager = require("./indexing/indexManager");
const { createSchema } = require("./schema/schema");

const asyncMaybe = async (fn, payload) => {
  if (typeof fn !== "function") {
    return;
  }

  await fn(payload);
};

const isOperator = (key) => key.startsWith("$");

const applySet = (target, spec) => {
  for (const [path, value] of Object.entries(spec)) {
    setByPath(target, path, value);
  }
};

const applyUnset = (target, spec) => {
  for (const path of Object.keys(spec)) {
    unsetByPath(target, path);
  }
};

const applyInc = (target, spec) => {
  for (const [path, increment] of Object.entries(spec)) {
    const current = Number(getByPath(target, path, 0));
    const next = current + increment;
    setByPath(target, path, next);
  }
};

const ensureArrayField = (target, path) => {
  const current = getByPath(target, path);
  if (current === undefined) {
    setByPath(target, path, []);
    return getByPath(target, path);
  }
  if (!Array.isArray(current)) {
    throw new Error(`Cannot perform array operation on non-array field "${path}"`);
  }
  return current;
};

const applyPush = (target, spec) => {
  for (const [path, value] of Object.entries(spec)) {
    const current = ensureArrayField(target, path);
    if (value && typeof value === "object" && "$each" in value) {
      current.push(...value.$each.map((entry) => cloneDeep(entry)));
    } else {
      current.push(cloneDeep(value));
    }
  }
};

const applyPull = (target, spec) => {
  for (const [path, value] of Object.entries(spec)) {
    const current = ensureArrayField(target, path);
    let predicate;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      predicate = (item) =>
        !matchFilter({ value: item }, { value });
    } else {
      predicate = (item) =>
        JSON.stringify(item) !== JSON.stringify(value);
    }

    const next = current.filter((item) => predicate(item));
    setByPath(target, path, next);
  }
};

const applyAddToSet = (target, spec) => {
  for (const [path, value] of Object.entries(spec)) {
    const current = ensureArrayField(target, path);
    const values =
      value && typeof value === "object" && "$each" in value
        ? value.$each
        : [value];

    for (const entry of values) {
      const exists = current.some(
        (item) => JSON.stringify(item) === JSON.stringify(entry),
      );
      if (!exists) {
        current.push(cloneDeep(entry));
      }
    }
  }
};

const resolveUpsertDocument = (filter, update, explicit, primaryKey) => {
  if (explicit) {
    const candidate = cloneDeep(explicit);
    return candidate;
  }

  if (update && typeof update === "object" && !Object.keys(update).some(isOperator)) {
    return cloneDeep(update);
  }

  const document = {};

  if (update && typeof update === "object" && update.$set) {
    Object.assign(document, cloneDeep(update.$set));
  }

  for (const [key, value] of Object.entries(filter || {})) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      document[key] = cloneDeep(value);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(document, primaryKey)) {
    document[primaryKey] = generateId();
  }

  if (Object.keys(document).length === 0) {
    throw new Error(
      "Unable to infer document for upsert. Provide options.upsertDocument.",
    );
  }

  return document;
};

const applyUpdate = (doc, update, primaryKey) => {
  if (!update || typeof update !== "object") {
    return doc;
  }

  if (!Object.keys(update).some(isOperator)) {
    const next = cloneDeep(update);
    if (!Object.prototype.hasOwnProperty.call(next, primaryKey)) {
      next[primaryKey] = doc[primaryKey];
    }
    return next;
  }

  const next = cloneDeep(doc);

  for (const [operator, spec] of Object.entries(update)) {
    if (!isOperator(operator)) {
      continue;
    }

    switch (operator) {
      case "$set":
        applySet(next, spec);
        break;
      case "$unset":
        applyUnset(next, spec);
        break;
      case "$inc":
        applyInc(next, spec);
        break;
      case "$push":
        applyPush(next, spec);
        break;
      case "$pull":
        applyPull(next, spec);
        break;
      case "$addToSet":
        applyAddToSet(next, spec);
        break;
      default:
        throw new Error(`Unsupported update operator "${operator}"`);
    }
  }

  return next;
};

class JsonCollection {
  constructor(config) {
    const persistedOptions = config.options || {};
    this._name = config.name;
    this._database = config.database;
    this._primaryKey = persistedOptions.primaryKey || "_id";
    this._options = {
      primaryKey: this._primaryKey,
      capped: Boolean(persistedOptions.capped),
      maxSize: persistedOptions.maxSize || null,
    };

    this.setSchema(config.runtime?.schema);

    this._runtime = {
      validator: config.runtime?.validator,
      hooks: config.runtime?.hooks || {},
    };

    this._documents = [];
    this._byId = new Map();
    this._indexes = new IndexManager(this._name);
    this.hydrateFromSnapshot(
      config.documents || [],
      config.indexes || {},
      persistedOptions,
    );
  }

  get name() {
    return this._name;
  }

  get size() {
    return this._documents.length;
  }

  get primaryKey() {
    return this._primaryKey;
  }

  toJSON() {
    return {
      name: this._name,
      options: this._options,
      indexes: this._indexes.toJSON(),
      documents: this._documents,
    };
  }

  async insertOne(document, options = {}) {
    const incoming = cloneDeep(document);

    if (!Object.prototype.hasOwnProperty.call(incoming, this._primaryKey)) {
      incoming[this._primaryKey] = generateId();
    }

    const id = incoming[this._primaryKey];

    if (this._byId.has(id)) {
      throw new Error(
        `Document with ${this._primaryKey} "${id}" already exists in collection "${this._name}"`,
      );
    }

    this._applySchema(incoming, { operation: "insert" });

    await asyncMaybe(this._runtime.validator, incoming);
    await asyncMaybe(this._runtime.hooks.beforeInsert, incoming);

    this._documents.push(incoming);
    this._byId.set(id, incoming);
    this._indexes.indexDocument(incoming);

    if (this._options.capped && this._options.maxSize && this._documents.length > this._options.maxSize) {
      const overflow = this._documents.length - this._options.maxSize;
      for (let i = 0; i < overflow; i += 1) {
        const removed = this._documents.shift();
        if (!removed) {
          continue;
        }

        const removedId = removed[this._primaryKey];
        await asyncMaybe(this._runtime.hooks.beforeDelete, cloneDeep(removed));
        this._byId.delete(removedId);
        this._indexes.unindexDocument(removed);
        await asyncMaybe(this._runtime.hooks.afterDelete, cloneDeep(removed));
      }
    }

    await this._database._notifyChange(this);

    await asyncMaybe(this._runtime.hooks.afterInsert, cloneDeep(incoming));

    return cloneDeep(incoming);
  }

  async insertMany(documents, options = {}) {
    const inserted = [];
    for (const document of documents) {
      const created = await this.insertOne(document, options);
      inserted.push(created);
    }
    return inserted;
  }

  async find(filter = {}, options = {}) {
    const candidates = this._indexes.candidatesForFilter(filter);
    let docs = this._documents;

    if (candidates) {
      docs = [];
      for (const id of candidates) {
        const doc = this._byId.get(id);
        if (doc) {
          docs.push(doc);
        }
      }
    }

    const results = queryDocuments(docs, filter, options);
    return results.map((doc) => cloneDeep(doc));
  }

  async findOne(filter = {}, options = {}) {
    const [first] = await this.find(filter, { ...options, limit: 1 });
    return first || null;
  }

  async at(index, filter = {}, options = {}) {
    if (!Number.isInteger(index)) {
      throw new Error("Collection.at index must be an integer");
    }

    if (index < 0) {
      throw new Error("Collection.at does not support negative indexes");
    }

    const [result] = await this.find(filter, {
      ...options,
      skip: index,
      limit: 1,
    });
    return result || null;
  }

  async findById(id) {
    const doc = this._byId.get(id);
    return doc ? cloneDeep(doc) : null;
  }

  async updateMany(filter, update, options = {}) {
    const { upsert = false, upsertDocument } = options;

    const matches = await this.find(filter, { projection: null });
    let matchedCount = 0;
    let modifiedCount = 0;

    for (const match of matches) {
      const id = match[this._primaryKey];
      const current = this._byId.get(id);
      const next = applyUpdate(current, update, this._primaryKey);

      if (next[this._primaryKey] !== id) {
        throw new Error("Updating the primary key is not supported");
      }

      const index = this._documents.indexOf(current);
      const previousSnapshot = cloneDeep(current);

      this._applySchema(next, {
        operation: "update",
        previous: previousSnapshot,
        update,
      });

      await asyncMaybe(this._runtime.validator, next);
      await asyncMaybe(this._runtime.hooks.beforeUpdate, {
        previous: cloneDeep(previousSnapshot),
        next: cloneDeep(next),
        update,
      });

      this._documents[index] = next;
      this._byId.set(id, next);
      this._indexes.updateDocument(previousSnapshot, next);

      matchedCount += 1;
      modifiedCount += JSON.stringify(previousSnapshot) === JSON.stringify(next)
        ? 0
        : 1;

      await asyncMaybe(this._runtime.hooks.afterUpdate, {
        previous: previousSnapshot,
        next: cloneDeep(next),
      });
    }

    if (matchedCount === 0 && upsert) {
      const candidate = resolveUpsertDocument(
        filter,
        update,
        upsertDocument,
        this._primaryKey,
      );
      const inserted = await this.insertOne(candidate);
      matchedCount = 1;
      modifiedCount = 1;
      return { matchedCount, modifiedCount, upsertedId: inserted[this._primaryKey] };
    }

    if (modifiedCount > 0) {
      await this._database._notifyChange(this);
    }

    return { matchedCount, modifiedCount };
  }

  async updateOne(filter, update, options = {}) {
    const { limit = 1 } = options;
    const matches = await this.find(filter, { limit });
    if (matches.length === 0) {
      if (options.upsert) {
        const candidate = resolveUpsertDocument(
          filter,
          update,
          options.upsertDocument,
          this._primaryKey,
        );
        const inserted = await this.insertOne(candidate);
        return {
          matchedCount: 0,
          modifiedCount: 0,
          upsertedId: inserted[this._primaryKey],
        };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const [first] = matches;
    const response = await this.updateMany(
      { [this._primaryKey]: first[this._primaryKey] },
      update,
      {
        upsert: options.upsert,
        upsertDocument: options.upsertDocument,
      },
    );
    return response;
  }

  async replaceOne(filter, replacement) {
    if (Object.keys(replacement).some(isOperator)) {
      throw new Error("Replacement document cannot contain update operators");
    }

    const match = await this.findOne(filter);
    if (!match) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const id = match[this._primaryKey];
    replacement[this._primaryKey] = id;
    return this.updateMany({ [this._primaryKey]: id }, replacement);
  }

  async deleteMany(filter = {}) {
    const matches = await this.find(filter);
    let deletedCount = 0;

    for (const match of matches) {
      const id = match[this._primaryKey];
      const current = this._byId.get(id);

      await asyncMaybe(this._runtime.hooks.beforeDelete, cloneDeep(current));

      this._byId.delete(id);
      this._indexes.unindexDocument(current);

      const index = this._documents.indexOf(current);
      if (index >= 0) {
        this._documents.splice(index, 1);
      }

      deletedCount += 1;

      await asyncMaybe(this._runtime.hooks.afterDelete, cloneDeep(current));
    }

    if (deletedCount > 0) {
      await this._database._notifyChange(this);
    }

    return { deletedCount };
  }

  async deleteOne(filter = {}) {
    const match = await this.findOne(filter);
    if (!match) {
      return { deletedCount: 0 };
    }

    return this.deleteMany({ [this._primaryKey]: match[this._primaryKey] });
  }

  async count(filter = {}) {
    const matches = await this.find(filter);
    return matches.length;
  }

  async distinct(field, filter = {}) {
    const matches = await this.find(filter, { distinct: field });
    return matches;
  }

  async countBy(field, filter = {}) {
    const matches = await this.find(filter, {
      projection: { [field]: 1 },
    });

    const buckets = new Map();

    for (const doc of matches) {
      const value = getByPath(doc, field);
      const key =
        value === undefined ? "__undefined__" : JSON.stringify(value);

      if (!buckets.has(key)) {
        buckets.set(key, {
          value: value === undefined ? undefined : cloneDeep(value),
          count: 0,
        });
      }

      const bucket = buckets.get(key);
      bucket.count += 1;
    }

    return Array.from(buckets.values());
  }

  async ensureIndex(field, options = {}) {
    this._indexes.ensureIndex(field, options);
    this._indexes.rebuild(this._documents);
    await this._database._notifyChange(this);
  }

  async dropIndex(field) {
    this._indexes.dropIndex(field);
    await this._database._notifyChange(this);
  }

  getStats() {
    return {
      name: this._name,
      count: this._documents.length,
      indexes: Array.from(this._indexes.indexes.keys()),
      options: this._options,
    };
  }

  hydrateFromSnapshot(documents = [], indexes = {}, options = {}) {
    if (options && Object.keys(options).length > 0) {
      this._options = {
        ...this._options,
        ...options,
      };
      if (options.primaryKey) {
        this._primaryKey = options.primaryKey;
      }
    }

    this._documents = [];
    this._byId = new Map();
    this._indexes = new IndexManager(this._name);
    this._indexes.loadFromSnapshot(indexes);

    for (const doc of documents) {
      const clone = cloneDeep(doc);
      if (!Object.prototype.hasOwnProperty.call(clone, this._primaryKey)) {
        clone[this._primaryKey] = generateId();
      }
      this._documents.push(clone);
      this._byId.set(clone[this._primaryKey], clone);
    }

    this._indexes.rebuild(this._documents);
  }

  async _purgeExpiredDocuments(now = Date.now()) {
    if (!this._indexes.hasTtlIndexes()) {
      return;
    }

    const expiredIds = Array.from(this._indexes.collectExpired(now));
    if (expiredIds.length === 0) {
      return;
    }

    await this.deleteMany({
      [this._primaryKey]: { $in: expiredIds },
    });
  }

  _hasTtlIndexes() {
    return this._indexes.hasTtlIndexes();
  }

  _applySchema(document, context) {
    if (!this._schema || typeof this._schema.validate !== "function") {
      return;
    }

    this._schema.validate(document, {
      ...context,
      collection: this,
      document,
      primaryKey: this._primaryKey,
    });
  }

  setSchema(schemaDefinition) {
    if (!schemaDefinition) {
      this._schema = null;
      return;
    }

    this._schema =
      typeof schemaDefinition.validate === "function"
        ? schemaDefinition
        : createSchema(schemaDefinition);
  }
}

module.exports = JsonCollection;
