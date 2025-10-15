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
const { createFieldEncryption } = require("./encryption/fieldEncryption");

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

const coercePartitionValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const selectGreaterLower = (aValue, aExclusive, bValue, bExclusive) => {
  if (aValue == null) {
    return { value: bValue, exclusive: bExclusive };
  }
  if (bValue == null) {
    return { value: aValue, exclusive: aExclusive };
  }
  if (aValue > bValue) {
    return { value: aValue, exclusive: aExclusive };
  }
  if (bValue > aValue) {
    return { value: bValue, exclusive: bExclusive };
  }
  return { value: aValue, exclusive: aExclusive || bExclusive };
};

const selectSmallerUpper = (aValue, aExclusive, bValue, bExclusive) => {
  if (aValue == null) {
    return { value: bValue, exclusive: bExclusive };
  }
  if (bValue == null) {
    return { value: aValue, exclusive: aExclusive };
  }
  if (aValue < bValue) {
    return { value: aValue, exclusive: aExclusive };
  }
  if (bValue < aValue) {
    return { value: bValue, exclusive: bExclusive };
  }
  return { value: aValue, exclusive: aExclusive || bExclusive };
};

const intersectRanges = (lhs, rhs) => {
  if (!lhs) {
    return rhs ? { ...rhs } : null;
  }
  if (!rhs) {
    return lhs ? { ...lhs } : null;
  }

  const lower = selectGreaterLower(lhs.min, lhs.minExclusive, rhs.min, rhs.minExclusive);
  const upper = selectSmallerUpper(lhs.max, lhs.maxExclusive, rhs.max, rhs.maxExclusive);

  if (lower.value != null && upper.value != null) {
    if (lower.value > upper.value) {
      return null;
    }
    if (lower.value === upper.value && (lower.exclusive || upper.exclusive)) {
      return null;
    }
  }

  return {
    min: lower.value,
    minExclusive: Boolean(lower.value != null && lower.exclusive),
    max: upper.value,
    maxExclusive: Boolean(upper.value != null && upper.exclusive),
  };
};

const parseRangeNode = (node) => {
  if (node == null) {
    return null;
  }

  if (Array.isArray(node)) {
    const values = node
      .map((value) => coercePartitionValue(value))
      .filter((value) => value != null);
    if (values.length === 0) {
      return null;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      min,
      max,
      minExclusive: false,
      maxExclusive: false,
    };
  }

  if (typeof node !== "object") {
    const value = coercePartitionValue(node);
    if (value == null) {
      return null;
    }
    return {
      min: value,
      max: value,
      minExclusive: false,
      maxExclusive: false,
    };
  }

  if (node.$eq !== undefined) {
    const value = coercePartitionValue(node.$eq);
    if (value == null) {
      return null;
    }
    return {
      min: value,
      max: value,
      minExclusive: false,
      maxExclusive: false,
    };
  }

  if (node.$in) {
    const values = node.$in
      .map((value) => coercePartitionValue(value))
      .filter((value) => value != null);
    if (values.length === 0) {
      return null;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      min,
      max,
      minExclusive: false,
      maxExclusive: false,
    };
  }

  let range = null;

  if (node.$gte !== undefined) {
    const value = coercePartitionValue(node.$gte);
    if (value == null) {
      return null;
    }
    range = intersectRanges(range, {
      min: value,
      minExclusive: false,
      max: null,
      maxExclusive: false,
    });
  }

  if (node.$gt !== undefined) {
    const value = coercePartitionValue(node.$gt);
    if (value == null) {
      return null;
    }
    range = intersectRanges(range, {
      min: value,
      minExclusive: true,
      max: null,
      maxExclusive: false,
    });
  }

  if (node.$lte !== undefined) {
    const value = coercePartitionValue(node.$lte);
    if (value == null) {
      return null;
    }
    range = intersectRanges(range, {
      min: null,
      minExclusive: false,
      max: value,
      maxExclusive: false,
    });
  }

  if (node.$lt !== undefined) {
    const value = coercePartitionValue(node.$lt);
    if (value == null) {
      return null;
    }
    range = intersectRanges(range, {
      min: null,
      minExclusive: false,
      max: value,
      maxExclusive: true,
    });
  }

  return range;
};

const extractRangeForKey = (filter, keyPath) => {
  if (!filter || typeof filter !== "object") {
    return null;
  }

  const direct = getByPath(filter, keyPath);
  if (direct !== undefined) {
    return parseRangeNode(direct);
  }

  if (Array.isArray(filter.$and)) {
    let combined = null;
    for (const clause of filter.$and) {
      const nextRange = extractRangeForKey(clause, keyPath);
      if (!nextRange) {
        continue;
      }
      combined = intersectRanges(combined, nextRange);
      if (!combined) {
        return null;
      }
    }
    return combined;
  }

  return null;
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
      partition: persistedOptions.partition || null,
    };

    this._runtime = {
      validator: config.runtime?.validator,
      hooks: config.runtime?.hooks || {},
    };

    this._documents = [];
    this._byId = new Map();
    this._indexes = new IndexManager(this._name);

    this._schema = null;
    this._encryption = null;
    this._partition = this._options.partition || null;
    this._partitionChunkCache = null;
    this._version = 0;

    this.setSchema(config.runtime?.schema);
    if (config.runtime && Object.prototype.hasOwnProperty.call(config.runtime, "partition")) {
      this.setPartition(config.runtime.partition);
    }
    this.setEncryption(config.runtime?.encryption);
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
      documents: this._documents.map((doc) => this._serializeDocument(doc)),
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

    const cappedRemovals = [];
    if (this._options.capped && this._options.maxSize && this._documents.length > this._options.maxSize) {
      const overflow = this._documents.length - this._options.maxSize;
      for (let i = 0; i < overflow; i += 1) {
        const removed = this._documents.shift();
        if (!removed) {
          continue;
        }

        const removedClone = cloneDeep(removed);
        const removedId = removedClone[this._primaryKey];
        await asyncMaybe(this._runtime.hooks.beforeDelete, removedClone);
        this._byId.delete(removedId);
        this._indexes.unindexDocument(removed);
        cappedRemovals.push(removedClone);
        await asyncMaybe(this._runtime.hooks.afterDelete, cloneDeep(removedClone));
      }
    }

    const result = cloneDeep(incoming);
    await asyncMaybe(this._runtime.hooks.afterInsert, cloneDeep(result));

    this._invalidatePartitionCache();

    await this._database._notifyChange(this, {
      type: "insert",
      documents: [cloneDeep(result)],
    });

    if (cappedRemovals.length > 0) {
      await this._database._notifyChange(this, {
        type: "delete",
        deleted: cappedRemovals.map((doc) => cloneDeep(doc)),
        reason: "capped",
      });
    }

    return result;
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
    let docs;
    let plan = null;

    if (candidates) {
      docs = [];
      for (const id of candidates) {
        const doc = this._byId.get(id);
        if (doc) {
          docs.push(doc);
        }
      }
    }

    if (!docs) {
      const selection = this._getDocsForFilter(filter);
      docs = selection.docs;
      plan = selection.plan;
    }

    const results = queryDocuments(docs, filter, options);
    if (plan) {
      plan.matched = results.length;
      this._lastPlan = { ...plan };
    } else {
      this._lastPlan = null;
    }
    return results.map((doc) => cloneDeep(doc));
  }

  stream(filter = {}, options = {}) {
    const self = this;
    return (async function* streamGenerator() {
      const docs = await self.find(filter, options);
      for (const doc of docs) {
        yield doc;
      }
    })();
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
    const updates = [];

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
      const changed = JSON.stringify(previousSnapshot) !== JSON.stringify(next);
      if (changed) {
        modifiedCount += 1;
        updates.push({
          previous: cloneDeep(previousSnapshot),
          next: cloneDeep(next),
        });
      }

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

    if (updates.length > 0) {
      this._invalidatePartitionCache();
      await this._database._notifyChange(this, {
        type: "update",
        updates,
        documents: updates.map((entry) => cloneDeep(entry.next)),
      });
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
    const deletedDocs = [];

    for (const match of matches) {
      const id = match[this._primaryKey];
      const current = this._byId.get(id);
      const snapshot = cloneDeep(current);

      await asyncMaybe(this._runtime.hooks.beforeDelete, cloneDeep(snapshot));

      this._byId.delete(id);
      this._indexes.unindexDocument(current);

      const index = this._documents.indexOf(current);
      if (index >= 0) {
        this._documents.splice(index, 1);
      }

      deletedCount += 1;
      deletedDocs.push(snapshot);

      await asyncMaybe(this._runtime.hooks.afterDelete, cloneDeep(snapshot));
    }

    if (deletedCount > 0) {
      this._invalidatePartitionCache();
      await this._database._notifyChange(this, {
        type: "delete",
        deleted: deletedDocs.map((doc) => cloneDeep(doc)),
      });
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
    await this._database._notifyChange(this, {
      type: "index",
      action: "ensure",
      field,
      options,
    });
  }

  async dropIndex(field) {
    this._indexes.dropIndex(field);
    await this._database._notifyChange(this, {
      type: "index",
      action: "drop",
      field,
    });
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

    const incoming = (documents || []).map((doc) => this._deserializeDocument(doc));

    for (const doc of incoming) {
      const clone = cloneDeep(doc);
      if (!Object.prototype.hasOwnProperty.call(clone, this._primaryKey)) {
        clone[this._primaryKey] = generateId();
      }
      this._documents.push(clone);
      this._byId.set(clone[this._primaryKey], clone);
    }

    this._indexes.rebuild(this._documents);
    this._partition = this._options.partition || null;
    this._invalidatePartitionCache();
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

  setPartition(partitionConfig) {
    if (!partitionConfig) {
      this._partition = null;
      this._options.partition = null;
      this._invalidatePartitionCache();
      return;
    }

    const chunkSize = Number(partitionConfig.chunkSize);
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
      throw new Error("partition.chunkSize must be a positive number");
    }

    const key = typeof partitionConfig.key === "string" && partitionConfig.key.length > 0
      ? partitionConfig.key
      : null;

    const normalized = {
      chunkSize: Math.floor(chunkSize),
      strategy: partitionConfig.strategy || "chunk",
      key,
    };

    this._partition = normalized;
    this._options.partition = normalized;
    this._invalidatePartitionCache();
  }

  _getPartitionChunks() {
    if (!this._partition || !this._partition.chunkSize) {
      return null;
    }

    if (
      this._partitionChunkCache &&
      this._partitionChunkCache.version === this._version
    ) {
      return this._partitionChunkCache.chunks;
    }

    const chunks = [];
    const chunkSize = this._partition.chunkSize;
    const keyPath = this._partition.key;

    let offset = 0;
    while (offset < this._documents.length) {
      const end = Math.min(offset + chunkSize, this._documents.length);
      const slice = this._documents.slice(offset, end);

      let min = null;
      let max = null;

      if (keyPath) {
        for (const doc of slice) {
          const value = coercePartitionValue(getByPath(doc, keyPath));
          if (value == null) {
            continue;
          }
          if (min === null || value < min) {
            min = value;
          }
          if (max === null || value > max) {
            max = value;
          }
        }
      }

      chunks.push({
        start: offset,
        end,
        count: slice.length,
        min,
        max,
      });

      offset = end;
    }

    this._partitionChunkCache = {
      version: this._version,
      chunks,
    };

    return chunks;
  }

  _chunkOverlaps(range, chunk) {
    if (chunk.count === 0) {
      return false;
    }

    if (range.min != null) {
      if (chunk.max == null) {
        // cannot determine, assume overlap
      } else if (range.minExclusive) {
        if (chunk.max <= range.min) {
          return false;
        }
      } else if (chunk.max < range.min) {
        return false;
      }
    }

    if (range.max != null) {
      if (chunk.min == null) {
        // assume overlap
      } else if (range.maxExclusive) {
        if (chunk.min >= range.max) {
          return false;
        }
      } else if (chunk.min > range.max) {
        return false;
      }
    }

    return true;
  }

  _planPartition(filter = {}) {
    if (!this._partition || !this._partition.chunkSize || !this._partition.key) {
      return null;
    }

    const chunks = this._getPartitionChunks() || [];
    const totalChunks = chunks.length;
    const totalDocs = this._documents.length;

    if (totalChunks === 0) {
      return {
        optimized: false,
        key: this._partition.key,
        range: null,
        totalChunks,
        scannedChunks: 0,
        documentsScanned: 0,
        chunks: [],
      };
    }

    const range = extractRangeForKey(filter, this._partition.key);
    if (!range) {
      return {
        optimized: false,
        key: this._partition.key,
        range: null,
        totalChunks,
        scannedChunks: totalChunks,
        documentsScanned: totalDocs,
        chunks,
      };
    }

    const selected = [];
    for (const chunk of chunks) {
      if (chunk.min == null || chunk.max == null) {
        selected.push(chunk);
        continue;
      }
      if (this._chunkOverlaps(range, chunk)) {
        selected.push(chunk);
      }
    }

    const documentsScanned = selected.reduce((sum, chunk) => sum + chunk.count, 0);

    return {
      optimized: selected.length < chunks.length,
      key: this._partition.key,
      range,
      totalChunks,
      scannedChunks: selected.length,
      documentsScanned,
      chunks: selected,
    };
  }

  _getDocsForFilter(filter = {}) {
    const plan = this._planPartition(filter);
    if (!plan || !plan.optimized) {
      return { docs: this._documents, plan };
    }

    if (plan.chunks.length === 0) {
      return { docs: [], plan };
    }

    const subset = [];
    for (const chunk of plan.chunks) {
      subset.push(...this._documents.slice(chunk.start, chunk.end));
    }

    return { docs: subset, plan };
  }

  explain(filter = {}) {
    return this._planPartition(filter);
  }

  _serializeDocument(doc) {
    if (!this._encryption) {
      return cloneDeep(doc);
    }

    return this._encryption.encryptDocument(doc);
  }

  _deserializeDocument(doc) {
    if (!this._encryption) {
      return cloneDeep(doc);
    }

    try {
      return this._encryption.decryptDocument(doc);
    } catch (error) {
      throw new Error(
        `Failed to decrypt document in collection "${this._name}": ${error.message}`,
      );
    }
  }

  _invalidatePartitionCache() {
    this._partitionChunkCache = null;
    this._version += 1;
  }

  setEncryption(encryptionConfig) {
    if (!encryptionConfig) {
      this._encryption = null;
      this._invalidatePartitionCache();
      return;
    }

    this._encryption = createFieldEncryption(encryptionConfig);

    if (this._documents.length > 0) {
      const nextDocuments = [];
      const nextById = new Map();

      for (const doc of this._documents) {
        const decrypted = this._encryption.decryptDocument(doc);
        nextDocuments.push(decrypted);
        nextById.set(decrypted[this._primaryKey], decrypted);
      }

      this._documents = nextDocuments;
      this._byId = nextById;
      this._indexes.rebuild(this._documents);
    }

    this._invalidatePartitionCache();
  }
}

module.exports = JsonCollection;
