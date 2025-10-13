"use strict";

const { getByPath } = require("../utils/objectUtils");

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

class IndexManager {
  constructor(collectionName) {
    this.collectionName = collectionName;
    this.indexes = new Map();
  }

  ensureIndex(field, options = {}) {
    if (this.indexes.has(field)) {
      return;
    }

    this.indexes.set(field, {
      field,
      options: {
        unique: Boolean(options.unique),
      },
      values: new Map(),
    });
  }

  dropIndex(field) {
    this.indexes.delete(field);
  }

  toJSON() {
    const snapshot = {};
    for (const [field, index] of this.indexes.entries()) {
      snapshot[field] = {
        options: index.options,
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
        throw new Error(
          `Duplicate value for unique index "${index.field}" in collection "${this.collectionName}"`,
        );
      }

      set.add(doc._id);
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
}

module.exports = IndexManager;
