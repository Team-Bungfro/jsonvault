# jsonvault architecture overview

This note describes the main pieces in jsonvault and how they work together.

## Goals

The project aims to keep a JSON based database simple to use, deliver fast developer workflows with promises and TypeScript support, offer dependable file persistence by writing atomically, and keep the dependency footprint small while still shipping indexes, filters, and transactions.

## Moving parts

JsonDatabase manages the life cycle, keeps track of collections, fires autosave, and wraps transactions. JsonCollection holds documents in memory, applies query helpers, and talks to the index manager. StorageAdapter provides a pluggable persistence interface, with FileStorageAdapter covering filesystem storage out of the box. QueryEngine evaluates filters, projections, sorting, and paging. IndexManager maintains in-memory maps for indexed fields and speeds up lookups. Utilities cover cloning, id generation, and similar helpers.

## Persistence model

The database writes to a directory that holds a meta.json file plus one JSON file per collection. Each collection file stores metadata, the document list, and index configuration. Writes happen through atomic file replacement. Transactions rely on in-memory snapshots for rollback, so no journal files yet.

## What the runtime supports

The API is async friendly and allows multiple collections per database. It includes insert, find, update, delete, count, distinct, and projection helpers. Filters recognize operators like `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$exists`, `$size`, `$contains`, `$startsWith`, `$endsWith`, `$and`, `$or`, and `$not`. Collections can maintain single field secondary indexes, including unique and TTL variants that clear expired documents automatically. Declarative schemas handle defaults, nested validation, and custom rules before user-defined validators run. Autosave runs through a debounced writer, with manual `save()` and `backup()` available when needed. Consumers can plug in validation callbacks and lifecycle hooks for inserts, updates, and deletes.

## TypeScript story

The package ships with type definitions that mirror the public API. Consumers get typed collections and filter helpers without pulling in extra runtime dependencies.

## Testing

Unit tests cover storage, indexes, query operators, and transaction rollback. The `examples` directory includes small runnable samples.

## Future ideas

Possible additions include alternative storage formats for large data sets and a small HTTP bridge.
