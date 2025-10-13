"use strict";

const { cloneDeep, getByPath } = require("../utils/objectUtils");
const { compareValues, matchFilter } = require("./operators");

const includeField = (target, path, value) => {
  const segments = path.split(".");
  let current = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  current[segments[segments.length - 1]] = value;
};

const projectDocument = (doc, projection) => {
  if (!projection || Object.keys(projection).length === 0) {
    return cloneDeep(doc);
  }

  const keys = Object.keys(projection);
  const isInclusive = keys.some((key) => projection[key]);
  const isExclusive = keys.some((key) => !projection[key]);

  if (isInclusive && isExclusive) {
    throw new Error("Projection cannot mix inclusive and exclusive fields");
  }

  if (isInclusive) {
    const output = {};
    for (const key of keys) {
      if (projection[key]) {
        const value = getByPath(doc, key);
        if (value !== undefined) {
          includeField(output, key, cloneDeep(value));
        }
      }
    }
    return output;
  }

  const output = cloneDeep(doc);
  for (const key of keys) {
    if (!projection[key]) {
      const segments = key.split(".");
      let current = output;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        if (!current || typeof current !== "object") {
          break;
        }
        current = current[segment];
      }
      if (current && typeof current === "object") {
        delete current[segments[segments.length - 1]];
      }
    }
  }

  return output;
};

const applySort = (docs, sortSpec) => {
  if (!sortSpec || Object.keys(sortSpec).length === 0) {
    return docs;
  }

  const sortEntries = Object.entries(sortSpec);
  const sorted = [...docs];

  sorted.sort((a, b) => {
    for (const [field, direction] of sortEntries) {
      const aValue = getByPath(a, field);
      const bValue = getByPath(b, field);
      const result = compareValues(aValue, bValue);

      if (result === 0) {
        continue;
      }

      return direction < 0 ? -result : result;
    }

    return 0;
  });

  return sorted;
};

const applyDistinct = (docs, field) => {
  const seen = new Set();
  const result = [];

  for (const doc of docs) {
    const value = getByPath(doc, field);
    const fingerprint = JSON.stringify(value);
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      result.push(value);
    }
  }

  return result;
};

const queryDocuments = (docs, filter = {}, options = {}) => {
  const {
    projection,
    sort,
    skip = 0,
    limit = Infinity,
    distinct,
  } = options;

  let cursor = [];

  for (const doc of docs) {
    if (matchFilter(doc, filter)) {
      cursor.push(projectDocument(doc, projection));
    }
  }

  if (distinct) {
    return applyDistinct(cursor, distinct);
  }

  if (sort) {
    cursor = applySort(cursor, sort);
  }

  if (skip) {
    cursor = cursor.slice(skip);
  }

  if (Number.isFinite(limit)) {
    cursor = cursor.slice(0, limit);
  }

  return cursor;
};

module.exports = {
  queryDocuments,
  projectDocument,
  applySort,
};
