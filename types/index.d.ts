export type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export interface OperatorExpression<T = any> {
  $eq?: T;
  $ne?: T;
  $gt?: T;
  $gte?: T;
  $lt?: T;
  $lte?: T;
  $in?: T[];
  $nin?: T[];
  $regex?: RegExp | string;
  $exists?: boolean;
  $size?: number;
  $contains?: T extends (infer U)[] ? U | U[] : T;
  $startsWith?: string;
  $endsWith?: string;
  $all?: T extends (infer U)[] ? U[] : any[];
  $elemMatch?: T extends (infer U)[] ? Filter<U & Record<string, any>> : Filter<Record<string, any>>;
  $not?: OperatorExpression<T> | T | RegExp;
  $mod?: [number, number];
  $type?: string | string[];
}

export type LogicalFilter<T extends Record<string, any> = Record<string, any>> = {
  $and?: Array<Filter<T>>;
  $or?: Array<Filter<T>>;
  $not?: Filter<T>;
  $nor?: Array<Filter<T>>;
};

export type Filter<T extends Record<string, any>> = {
  [P in keyof T]?: T[P] | OperatorExpression<T[P]>;
} & LogicalFilter<T> & {
  [path: string]: any;
};

export interface Projection {
  [field: string]: 0 | 1 | boolean;
}

export type SortDirection = 1 | -1;

export enum SortEnum {
  ASC = 1,
  DESC = -1,
}

export declare const Sort: typeof SortEnum;

export type SortSpec<T extends Record<string, any> = Record<string, any>> =
  Partial<Record<keyof T, SortDirection | SortEnum>> & {
    [path: string]: SortDirection | SortEnum;
  };

export interface QueryOptions<T extends Record<string, any> = Record<string, any>> {
  projection?: Projection;
  sort?: SortSpec<T>;
  skip?: number;
  limit?: number;
  distinct?: string;
}

export type SchemaTypeName = "string" | "number" | "boolean" | "date" | "array" | "object" | "any";

export interface SchemaContext<TDocument extends Record<string, any> = Record<string, any>> {
  document: TDocument;
  operation?: "insert" | "update" | string;
  path?: string;
  collection?: JsonCollection<TDocument>;
  [key: string]: any;
}

export interface SchemaFieldBase<TValue = any, TDocument extends Record<string, any> = Record<string, any>> {
  type?: SchemaTypeName;
  required?: boolean;
  allowNull?: boolean;
  default?: TValue | (() => TValue);
  enum?: TValue[];
  min?: number | Date;
  max?: number | Date;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp | string;
  trim?: boolean;
  description?: string;
  validate?(value: TValue, context: SchemaContext<TDocument>): boolean | void | TValue;
  transform?(value: TValue, context: SchemaContext<TDocument>): TValue;
}

export interface SchemaArrayField<TValue = any, TDocument extends Record<string, any> = Record<string, any>>
  extends SchemaFieldBase<TValue[], TDocument> {
  type: "array";
  items?: SchemaFieldDefinition<TDocument> | SchemaTypeName;
}

export interface SchemaObjectField<TValue = any, TDocument extends Record<string, any> = Record<string, any>>
  extends SchemaFieldBase<TValue, TDocument> {
  type: "object";
  fields?: SchemaFields<TDocument>;
  allowAdditional?: boolean;
}

export type SchemaFieldDefinition<TDocument extends Record<string, any> = Record<string, any>> =
  | SchemaFieldBase<any, TDocument>
  | SchemaArrayField<any, TDocument>
  | SchemaObjectField<any, TDocument>
  | SchemaTypeName;

export type SchemaFields<TDocument extends Record<string, any> = Record<string, any>> = {
  [K in keyof TDocument]?: SchemaFieldDefinition<TDocument>;
} & {
  [path: string]: SchemaFieldDefinition<TDocument>;
};

export interface SchemaDefinition<TDocument extends Record<string, any> = Record<string, any>> {
  fields?: SchemaFields<TDocument>;
  allowAdditional?: boolean;
}

export interface Schema<TDocument extends Record<string, any> = Record<string, any>> {
  validate(document: TDocument, context?: Partial<SchemaContext<TDocument>>): TDocument;
  definition: {
    fields: Record<string, SchemaFieldDefinition<TDocument>>;
    allowAdditional: boolean;
  };
}

export interface EncryptionOptions {
  secret: string;
  fields: string[];
  algorithm?: string;
}

export interface PartitionOptions {
  chunkSize: number;
  strategy?: string;
  key?: string;
}

export type ChangeType = "insert" | "update" | "delete" | "index";

export interface ChangeEvent<T extends Record<string, any> = Record<string, any>> {
  collection: string;
  primaryKey: string;
  type: ChangeType;
  action?: string;
  documents?: T[];
  updates?: Array<{ previous: T; next: T }>;
  deleted?: T[];
  timestamp: string;
  paths: string[];
  [key: string]: any;
}

export interface WatchHandle<T extends Record<string, any> = Record<string, any>> {
  on(event: "change", listener: (event: ChangeEvent<T>) => void): this;
  once(event: "change", listener: (event: ChangeEvent<T>) => void): this;
  off(event: "change", listener: (event: ChangeEvent<T>) => void): this;
  close(): void;
}

export interface ChangeLogEntry<T extends Record<string, any> = Record<string, any>> extends ChangeEvent<T> {
  seq: number;
}

export interface ChangeLogReadOptions {
  from?: number;
  limit?: number;
}

export interface ChangeLog<T extends Record<string, any> = Record<string, any>> {
  read(options?: ChangeLogReadOptions): Promise<ChangeLogEntry<T>[]>;
  clear(): Promise<void>;
}

export interface PartitionPlan {
  optimized: boolean;
  key?: string;
  range: {
    min: number | null;
    max: number | null;
    minExclusive?: boolean;
    maxExclusive?: boolean;
  } | null;
  totalChunks: number;
  scannedChunks: number;
  documentsScanned: number;
  matched?: number;
  chunks: Array<{
    start: number;
    end: number;
    count: number;
    min: number | null;
    max: number | null;
  }>;
}

export type UpdateInstruction<T extends Record<string, any>> =
  | Partial<T>
  | {
      $set?: Partial<T>;
      $unset?: Record<string, true | 1>;
      $inc?: Record<string, number>;
      $push?: Record<string, any>;
      $pull?: Record<string, any>;
      $addToSet?: Record<string, any>;
    };

export interface UpdateManyResult {
  matchedCount: number;
  modifiedCount: number;
  upsertedId?: string;
}

export interface DeleteResult {
  deletedCount: number;
}

export interface UpdateOptions<T extends Record<string, any>> {
  upsert?: boolean;
  upsertDocument?: Partial<T>;
}

export interface CollectionHooks<T extends Record<string, any>> {
  beforeInsert?(document: T): void | Promise<void>;
  afterInsert?(document: T): void | Promise<void>;
  beforeUpdate?(
    context: {
      previous: T;
      next: T;
      update: UpdateInstruction<T>;
    }
  ): void | Promise<void>;
  afterUpdate?(context: { previous: T; next: T }): void | Promise<void>;
  beforeDelete?(document: T): void | Promise<void>;
  afterDelete?(document: T): void | Promise<void>;
}

export interface CollectionRuntimeOptions<T extends Record<string, any>> {
  primaryKey?: keyof T extends string ? keyof T : string;
  validator?(document: T): void | Promise<void>;
  hooks?: CollectionHooks<T>;
  schema?: Schema<T> | SchemaDefinition<T> | SchemaFields<T>;
  encryption?: EncryptionOptions;
  partition?: PartitionOptions;
}

export interface CollectionOptions {
  primaryKey?: string;
  capped?: boolean;
  maxSize?: number | null;
  partition?: PartitionOptions | null;
}

export interface CollectionStats {
  name: string;
  count: number;
  indexes: string[];
  options: CollectionOptions;
}

export class JsonCollection<T extends Record<string, any> = Record<string, any>> {
  readonly name: string;
  readonly primaryKey: string;

  insertOne(document: Partial<T> & { [key: string]: any }): Promise<T>;
  insertMany(documents: Array<Partial<T> & { [key: string]: any }>): Promise<T[]>;
  find(filter?: Filter<T>, options?: QueryOptions<T>): Promise<T[]>;
  findOne(filter?: Filter<T>, options?: QueryOptions<T>): Promise<T | null>;
  at(index: number, filter?: Filter<T>, options?: QueryOptions<T>): Promise<T | null>;
  findById(id: string): Promise<T | null>;
  updateOne(filter: Filter<T>, update: UpdateInstruction<T>, options?: UpdateOptions<T>): Promise<UpdateManyResult>;
  updateMany(filter: Filter<T>, update: UpdateInstruction<T>, options?: UpdateOptions<T>): Promise<UpdateManyResult>;
  replaceOne(filter: Filter<T>, replacement: T): Promise<UpdateManyResult>;
  deleteOne(filter: Filter<T>): Promise<DeleteResult>;
  deleteMany(filter: Filter<T>): Promise<DeleteResult>;
  count(filter?: Filter<T>): Promise<number>;
  distinct<K extends keyof T | string>(field: K, filter?: Filter<T>): Promise<Array<T[K & keyof T]>>;
  countBy<K extends keyof T | string>(field: K, filter?: Filter<T>): Promise<Array<{ value: T[K & keyof T] | any; count: number }>>;
  ensureIndex(field: keyof T | string, options?: {
    unique?: boolean;
    ttlSeconds?: number;
    expireAfterSeconds?: number;
  }): Promise<void>;
  dropIndex(field: keyof T | string): Promise<void>;
  getStats(): CollectionStats;
  explain(filter?: Filter<T>): PartitionPlan | null;
  stream(filter?: Filter<T>, options?: QueryOptions<T>): AsyncIterable<T>;
}

export interface StorageAdapter {
  init(): Promise<void>;
  readMeta(): Promise<Record<string, any>>;
  writeMeta(meta: Record<string, any>): Promise<Record<string, any> | void>;
  listCollections(): Promise<string[]>;
  readCollection(name: string): Promise<{
    name: string;
    documents: any[];
    indexes: Record<string, any>;
    options: CollectionOptions;
  }>;
  writeCollection(name: string, payload: any): Promise<void>;
  deleteCollection(name: string): Promise<void>;
  backup(destination?: string): Promise<string>;
}

export type AdapterFactory = (options?: Record<string, any>) => StorageAdapter;

export interface ChangeLogOptions {
  path?: string;
  directory?: string;
  maxEntries?: number;
  maxSize?: number;
  autoArchive?: boolean;
  archiveDirectory?: string;
}

export interface PolicyReadPayload<T extends Record<string, any> = Record<string, any>> {
  row: T;
  ctx: Record<string, any> | null;
}

export type PolicyOperation = "insert" | "update" | "delete";

export interface PolicyWritePayload<T extends Record<string, any> = Record<string, any>> {
  previous: T | null;
  next: T | null;
  ctx: Record<string, any> | null;
  operation: PolicyOperation;
}

export interface PolicyRedactPayload<T extends Record<string, any> = Record<string, any>> {
  row: T;
  ctx: Record<string, any> | null;
}

export interface CollectionPolicy<T extends Record<string, any> = Record<string, any>> {
  read?(payload: PolicyReadPayload<T>): boolean | Promise<boolean>;
  write?(payload: PolicyWritePayload<T>): boolean | Promise<boolean>;
  redact?(payload: PolicyRedactPayload<T>): T | null | Promise<T | null>;
}

export interface JsonDatabaseOptions {
  path?: string;
  autosave?: boolean;
  autosaveInterval?: number;
  storage?: StorageAdapter;
  ttlIntervalMs?: number;
  adapter?: string;
  adapterOptions?: Record<string, any>;
  changeLog?: boolean | ChangeLogOptions;
}

export interface DatabaseStats {
  path: string;
  collections: CollectionStats[];
  totalDocuments: number;
}

export interface DatabaseSnapshot {
  meta: Record<string, any>;
  collections: Record<string, {
    name: string;
    documents: any[];
    indexes: Record<string, any>;
    options: CollectionOptions;
  }>;
}

export interface CompileSpec<T extends Record<string, any> = Record<string, any>> {
  collection: string;
  filter?: Filter<T>;
  options?: QueryOptions<T>;
}

export interface CompiledQuery<T extends Record<string, any> = Record<string, any>> {
  type: string;
  collection: string;
  execute(db: JsonDatabase, options?: QueryOptions<T>): AsyncIterable<T>;
  explain?(db: JsonDatabase): PartitionPlan | null;
}

export class FileStorageAdapter implements StorageAdapter {
  constructor(options?: { directory?: string; backupDir?: string });
  init(): Promise<void>;
  readMeta(): Promise<Record<string, any>>;
  writeMeta(meta: Record<string, any>): Promise<Record<string, any> | void>;
  listCollections(): Promise<string[]>;
  readCollection(name: string): Promise<{
    name: string;
    documents: any[];
    indexes: Record<string, any>;
    options: CollectionOptions;
  }>;
  writeCollection(name: string, payload: any): Promise<void>;
  deleteCollection(name: string): Promise<void>;
  backup(destination?: string): Promise<string>;
}

export class JsonDatabase {
  static open(options?: JsonDatabaseOptions): Promise<JsonDatabase>;
  collection<T extends Record<string, any> = Record<string, any>>(
    name: string,
    options?: CollectionRuntimeOptions<T>
  ): JsonCollection<T>;
  listCollections(): string[];
  dropCollection(name: string): Promise<void>;
  save(): Promise<void>;
  backup(destination?: string): Promise<string>;
  purgeExpired(): Promise<void>;
  compact(): Promise<void>;
  watch<T extends Record<string, any> = Record<string, any>>(pattern?: string): WatchHandle<T>;
  readonly changeLog?: ChangeLog;
  snapshot(): Promise<DatabaseSnapshot>;
  restore(snapshot: DatabaseSnapshot): Promise<void>;
  compile<T extends Record<string, any> = Record<string, any>>(input: string | CompileSpec<T>): CompiledQuery<T>;
  stream<T extends Record<string, any> = Record<string, any>>(query: CompiledQuery<T>, options?: QueryOptions<T>): AsyncIterable<T>;
  sql<TResult = any>(strings: TemplateStringsArray | string, ...values: any[]): Promise<TResult[]>;
  transaction<R>(callback: (db: JsonDatabase) => R | Promise<R>): Promise<R>;
  stats(): Promise<DatabaseStats>;
  close(): Promise<void>;
  getAppliedMigrations(): Array<{ id: string; appliedAt: string; description?: string | null }>;
  recordMigrationApplied(id: string, info?: { description?: string | null; appliedAt?: string }): Promise<void>;
  recordMigrationReverted(id: string): Promise<void>;
  policy<T extends Record<string, any> = Record<string, any>>(collection: string, definition: CollectionPolicy<T>): void;
  with(context: Record<string, any>): JsonDatabase;
  get(path: string): Promise<any>;
  getContext(): Record<string, any> | null;
}

export declare const queryDocuments: <T extends Record<string, any>>(
  docs: T[],
  filter?: Filter<T>,
  options?: QueryOptions<T>
) => T[];

export declare const operators: {
  matchFilter<T extends Record<string, any>>(doc: T, filter?: Filter<T>): boolean;
};

export declare class JsonVaultError extends Error {
  constructor(message?: string, details?: Record<string, any>, code?: string);
  readonly details: Record<string, any>;
  readonly code: string;
  static readonly code: string;
}

export declare class InvalidArgumentError extends JsonVaultError {
  constructor(message?: string, details?: Record<string, any>);
  static readonly code: string;
}

export declare class InvalidOperationError extends JsonVaultError {
  constructor(message?: string, details?: Record<string, any>);
  static readonly code: string;
}

export declare class NotFoundError extends JsonVaultError {
  constructor(message?: string, details?: Record<string, any>);
  static readonly code: string;
}

export declare class AlreadyExistsError extends JsonVaultError {
  constructor(message?: string, details?: Record<string, any>);
  static readonly code: string;
}

export declare class QueryError extends JsonVaultError {
  constructor(message?: string, details?: Record<string, any>);
  static readonly code: string;
}

export declare class PolicyDeniedError extends JsonVaultError {
  constructor(message?: string, details?: Record<string, any>);
  static readonly code: string;
}

export default JsonDatabase;

export declare function createSchema<T extends Record<string, any>>(
  definition: SchemaDefinition<T> | SchemaFields<T>
): Schema<T>;

export declare function registerAdapter(name: string, factory: AdapterFactory): void;
export declare function listAdapters(): string[];
export declare const adapters: {
  createJsonAdapter: AdapterFactory;
  createYamlAdapter: AdapterFactory;
};

export interface MigrationInfo {
  id: string;
  description?: string | null;
}

export interface AppliedMigrationInfo extends MigrationInfo {
  appliedAt: string;
}

export interface MigrationOptions {
  directory?: string;
  to?: string;
  step?: number;
  dryRun?: boolean;
}

export interface MigrationResult {
  ran: MigrationInfo[];
  dryRun: boolean;
}

export interface CreateMigrationOptions {
  directory?: string;
  name?: string;
  template?: (id: string) => string;
}

export interface CreateMigrationResult {
  id: string;
  file: string;
}

export interface MigrationStatus {
  applied: AppliedMigrationInfo[];
  pending: MigrationInfo[];
}

export declare function loadMigrations(directory?: string): Promise<Array<MigrationInfo & {
  file: string;
  up: (db: JsonDatabase) => any;
  down?: (db: JsonDatabase) => any;
}>>;
export declare function migrateUp(db: JsonDatabase, options?: MigrationOptions): Promise<MigrationResult>;
export declare function migrateDown(db: JsonDatabase, options?: MigrationOptions): Promise<MigrationResult>;
export declare function migrationStatus(db: JsonDatabase, options?: { directory?: string }): Promise<MigrationStatus>;
export declare function createMigration(options?: CreateMigrationOptions): Promise<CreateMigrationResult>;
export declare const migrations: {
  loadMigrations: typeof loadMigrations;
  migrateUp: typeof migrateUp;
  migrateDown: typeof migrateDown;
  migrationStatus: typeof migrationStatus;
  createMigration: typeof createMigration;
};
