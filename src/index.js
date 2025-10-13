"use strict";

const JsonDatabase = require("./database");
const JsonCollection = require("./collection");
const FileStorageAdapter = require("./storage/fileStorageAdapter");
const { matchFilter } = require("./query/operators");
const { queryDocuments } = require("./query/queryEngine");
const { createSchema } = require("./schema/schema");

module.exports = {
  JsonDatabase,
  JsonCollection,
  FileStorageAdapter,
  createSchema,
  operators: {
    matchFilter,
  },
  queryDocuments,
};
