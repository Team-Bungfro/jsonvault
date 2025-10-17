"use strict";

const FileStorageAdapter = require("../storage/fileStorageAdapter");
const { InvalidArgumentError, InvalidOperationError } = require("../errors");

const registry = new Map();

const createJsonAdapter = (options = {}) =>
  new FileStorageAdapter(options);

const ensureYaml = () => {
  try {
    // eslint-disable-next-line global-require
    return require("yaml");
  } catch (error) {
    throw new InvalidOperationError(
      "YAML adapter requires the 'yaml' package. Install it with `npm install yaml`.",
    );
  }
};

const createYamlAdapter = (options = {}) => {
  const yaml = ensureYaml();

  const serializer = {
    extension: "yaml",
    stringify: (data) => yaml.stringify(data),
    parse: (raw) => yaml.parse(raw),
  };

  return new FileStorageAdapter({ ...options, serializer });
};

const createMemoryAdapter = () => {
  const collections = new Map();
  let meta = { version: 1 };

  const clone = (input) => JSON.parse(JSON.stringify(input));

  return {
    async init() {},
    async readMeta() {
      return clone(meta);
    },
    async writeMeta(nextMeta) {
      meta = { ...meta, ...nextMeta };
      return clone(meta);
    },
    async listCollections() {
      return Array.from(collections.keys());
    },
    async readCollection(name) {
      if (collections.has(name)) {
        return clone(collections.get(name));
      }
      return {
        name,
        documents: [],
        indexes: {},
        options: {},
      };
    },
    async writeCollection(name, payload) {
      collections.set(name, clone(payload));
    },
    async deleteCollection(name) {
      collections.delete(name);
    },
    async backup() {
      return "";
    },
  };
};

const registerAdapter = (name, factory) => {
  if (!name) {
    throw new InvalidArgumentError("Adapter name is required");
  }
  if (typeof factory !== "function") {
    throw new InvalidArgumentError("Adapter factory must be a function");
  }
  registry.set(name, factory);
};

const getAdapter = (name) => {
  if (!registry.has(name)) {
    return null;
  }
  return registry.get(name);
};

const listAdapters = () => Array.from(registry.keys());

registerAdapter("json", (options) => createJsonAdapter(options));

registerAdapter("yaml", (options) => createYamlAdapter(options));
registerAdapter("memory", () => createMemoryAdapter());

module.exports = {
  registerAdapter,
  getAdapter,
  listAdapters,
  createJsonAdapter,
  createYamlAdapter,
  createMemoryAdapter,
};
