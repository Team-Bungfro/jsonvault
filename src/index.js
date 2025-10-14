"use strict";

const JsonDatabase = require("./database");
const JsonCollection = require("./collection");
const FileStorageAdapter = require("./storage/fileStorageAdapter");
const { matchFilter } = require("./query/operators");
const { queryDocuments, Sort } = require("./query/queryEngine");
const { createSchema } = require("./schema/schema");
const {
  registerAdapter,
  listAdapters,
  createJsonAdapter,
  createYamlAdapter,
} = require("./adapters");

module.exports = {
  JsonDatabase,
  JsonCollection,
  FileStorageAdapter,
  createSchema,
  registerAdapter,
  listAdapters,
  adapters: {
    createJsonAdapter,
    createYamlAdapter,
  },
  operators: {
    matchFilter,
  },
  queryDocuments,
  Sort,
};
