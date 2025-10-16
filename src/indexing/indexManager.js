"use strict";

const { getByPath } = require("../utils/objectUtils");
const {
  InvalidArgumentError,
  AlreadyExistsError,
} = require("../errors");

const fingerprint = (value) => {
  if (value === undefined) {
    return "__undefined__";
  }
  if (value === null) {
    return "__null__";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return `${typeof value}:${value}`;
};

const resolveTimestamp = (field, value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  throw new InvalidArgumentError(
    `Cannot index field "${field}" as TTL because the value "${value}" is not a date, number, or ISO string.`,
  );
};

class IndexManager {
  constructor(collectionName) {
    this.collectionName = collectionName;
    this.indexes = new Map();
  }

  ensureIndex(field, rawOptions = {}) {
    if (this.indexes.has(field)) {
      return;
    }

    const ttlSeconds = this._normalizeTtl(rawOptions);
    const options = {
      unique: Boolean(rawOptions.unique),
    };

    if (ttlSeconds !== null) {
      options.ttlSeconds = ttlSeconds;
    }

    this.indexes.set(field, {
      field,
      options,
      values: new Map(),
      ttl: ttlSeconds !== null ? new Map() : null,
    });
  }

  _normalizeTtl(options = {}) {
    if (
      options.ttlSeconds === undefined &&
      options.expireAfterSeconds === undefined
    ) {
      return null;
    }

    const ttlValue =
      options.ttlSeconds !== undefined
        ? Number(options.ttlSeconds)
        : Number(options.expireAfterSeconds);

    if (!Number.isFinite(ttlValue) || ttlValue <= 0) {
      throw new InvalidArgumentError(
        `ttlSeconds/expireAfterSeconds for collection "${this.collectionName}" must be a positive number`,
      );
    }

    return ttlValue;
  }

  dropIndex(field) {
    this.indexes.delete(field);
  }

  toJSON() {
    const snapshot = {};
    for (const [field, index] of this.indexes.entries()) {
      snapshot[field] = {
        options: { ...index.options },
      };
    }
    return snapshot;
  }

  loadFromSnapshot(snapshot = {}) {
    for (const field of Object.keys(snapshot)) {
      this.ensureIndex(field, snapshot[field].options);
    }
  }

  rebuild(documents) {
    for (const index of this.indexes.values()) {
      index.values.clear();
      if (index.ttl) {
        index.ttl.clear();
      }
    }

    for (const doc of documents) {
      this.indexDocument(doc);
    }
  }

  indexDocument(doc) {
    for (const index of this.indexes.values()) {
      const value = getByPath(doc, index.field);
      const key = fingerprint(value);

      if (!index.values.has(key)) {
        index.values.set(key, new Set());
      }

      const set = index.values.get(key);
      if (index.options.unique && set.size > 0) {
        throw new AlreadyExistsError(
          `Duplicate value for unique index "${index.field}" in collection "${this.collectionName}"`,
        );
      }

      set.add(doc._id);

      if (index.ttl) {
        const baseTime = resolveTimestamp(index.field, value);
        if (baseTime === null) {
          index.ttl.delete(doc._id);
        } else {
          index.ttl.set(
            doc._id,
            baseTime + index.options.ttlSeconds * 1000,
          );
        }
      }
    }
  }

  unindexDocument(doc) {
    for (const index of this.indexes.values()) {
      const value = getByPath(doc, index.field);
      const key = fingerprint(value);

      if (!index.values.has(key)) {
        continue;
      }

      const set = index.values.get(key);
      set.delete(doc._id);
      if (set.size === 0) {
        index.values.delete(key);
      }

      if (index.ttl) {
        index.ttl.delete(doc._id);
      }
    }
  }

  updateDocument(previousDoc, nextDoc) {
    this.unindexDocument(previousDoc);
    this.indexDocument(nextDoc);
  }

  candidatesForFilter(filter = {}) {
    if (!filter || typeof filter !== "object") {
      return null;
    }

    for (const [field, criteria] of Object.entries(filter)) {
      if (!this.indexes.has(field)) {
        continue;
      }

      const index = this.indexes.get(field);

      if (criteria && typeof criteria === "object") {
        if (Object.prototype.hasOwnProperty.call(criteria, "$eq")) {
          return this.lookupValue(index, criteria.$eq);
        }
        if (Object.prototype.hasOwnProperty.call(criteria, "$in")) {
          return this.lookupMany(index, criteria.$in);
        }
      } else {
        return this.lookupValue(index, criteria);
      }
    }

    return null;
  }

  lookupValue(index, value) {
    const key = fingerprint(value);
    const set = index.values.get(key);
    if (!set) {
      return new Set();
    }
    return new Set(set);
  }

  lookupMany(index, values) {
    const output = new Set();
    for (const value of values) {
      const key = fingerprint(value);
      const set = index.values.get(key);
      if (set) {
        for (const id of set) {
          output.add(id);
        }
      }
    }
    return output;
  }

  hasTtlIndexes() {
    for (const index of this.indexes.values()) {
      if (index.ttl) {
        return true;
      }
    }
    return false;
  }

  collectExpired(now = Date.now()) {
    const expired = new Set();

    for (const index of this.indexes.values()) {
      if (!index.ttl) {
        continue;
      }

      for (const [docId, expiry] of index.ttl.entries()) {
        if (expiry <= now) {
          expired.add(docId);
        }
      }
    }

    return expired;
  }
}

module.exports = IndexManager;
