"use strict";

const JsonDatabase = require("./database");
const JsonCollection = require("./collection");
const FileStorageAdapter = require("./storage/fileStorageAdapter");
const { matchFilter } = require("./query/operators");
const { queryDocuments } = require("./query/queryEngine");

module.exports = {
  JsonDatabase,
  JsonCollection,
  FileStorageAdapter,
  operators: {
    matchFilter,
  },
  queryDocuments,
};
