"use strict";

const pathCache = new Map();

const splitPath = (path) => {
  if (Array.isArray(path)) {
    return path;
  }

  if (pathCache.has(path)) {
    return pathCache.get(path);
  }

  const segments = path
    .replace(/\[(\d+)\]/g, ".$1") // convert array-style access
    .split(".")
    .filter(Boolean);

  pathCache.set(path, segments);
  return segments;
};

const clonePrimitive = (value) => {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof RegExp) {
    return new RegExp(value);
  }

  if (value instanceof Map) {
    return new Map(value);
  }

  if (value instanceof Set) {
    return new Set(value);
  }

  return value;
};

const cloneDeep = (value) => {
  if (value instanceof Date || value instanceof RegExp) {
    return clonePrimitive(value);
  }

  if (value instanceof Map) {
    return new Map(Array.from(value.entries()).map(([key, item]) => [key, cloneDeep(item)]));
  }

  if (value instanceof Set) {
    return new Set(Array.from(value).map((item) => cloneDeep(item)));
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneDeep(item));
  }

  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = cloneDeep(item);
    }
    return output;
  }

  return clonePrimitive(value);
};

const getByPath = (target, path, defaultValue) => {
  if (!target || typeof target !== "object") {
    return defaultValue;
  }

  const segments = splitPath(path);
  let current = target;

  for (const key of segments) {
    if (current == null || typeof current !== "object") {
      return defaultValue;
    }
    current = current[key];
  }

  return current === undefined ? defaultValue : current;
};

const setByPath = (target, path, value) => {
  const segments = splitPath(path);
  let current = target;

  for (let i = 0; i < segments.length; i += 1) {
    const key = segments[i];

    if (i === segments.length - 1) {
      current[key] = value;
      return value;
    }

    if (
      current[key] == null ||
      typeof current[key] !== "object" ||
      current[key] instanceof Date
    ) {
      current[key] = Number.isInteger(Number(segments[i + 1])) ? [] : {};
    }

    current = current[key];
  }

  return value;
};

const unsetByPath = (target, path) => {
  const segments = splitPath(path);
  let current = target;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!current || typeof current !== "object") {
      return false;
    }
    current = current[key];
  }

  const lastKey = segments[segments.length - 1];
  if (
    current &&
    Object.prototype.hasOwnProperty.call(current, lastKey)
  ) {
    delete current[lastKey];
    return true;
  }

  return false;
};

module.exports = {
  splitPath,
  cloneDeep,
  getByPath,
  setByPath,
  unsetByPath,
};
