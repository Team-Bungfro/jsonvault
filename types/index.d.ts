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
}

export type LogicalFilter<T> = {
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

export type SortSpec<T extends Record<string, any> = Record<string, any>> =
  Partial<Record<keyof T, SortDirection>> & {
    [path: string]: SortDirection;
  };

export interface QueryOptions<T extends Record<string, any> = Record<string, any>> {
  projection?: Projection;
  sort?: SortSpec<T>;
  skip?: number;
  limit?: number;
  distinct?: string;
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
}

export interface CollectionOptions {
  primaryKey?: string;
  capped?: boolean;
  maxSize?: number | null;
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
  findById(id: string): Promise<T | null>;
  updateOne(filter: Filter<T>, update: UpdateInstruction<T>, options?: UpdateOptions<T>): Promise<UpdateManyResult>;
  updateMany(filter: Filter<T>, update: UpdateInstruction<T>, options?: UpdateOptions<T>): Promise<UpdateManyResult>;
  replaceOne(filter: Filter<T>, replacement: T): Promise<UpdateManyResult>;
  deleteOne(filter: Filter<T>): Promise<DeleteResult>;
  deleteMany(filter: Filter<T>): Promise<DeleteResult>;
  count(filter?: Filter<T>): Promise<number>;
  distinct<K extends keyof T | string>(field: K, filter?: Filter<T>): Promise<Array<T[K & keyof T]>>;
  ensureIndex(field: keyof T | string, options?: { unique?: boolean }): Promise<void>;
  dropIndex(field: keyof T | string): Promise<void>;
  getStats(): CollectionStats;
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

export interface JsonDatabaseOptions {
  path?: string;
  autosave?: boolean;
  autosaveInterval?: number;
  storage?: StorageAdapter;
}

export interface DatabaseStats {
  path: string;
  collections: CollectionStats[];
  totalDocuments: number;
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
  transaction<R>(callback: (db: JsonDatabase) => R | Promise<R>): Promise<R>;
  stats(): Promise<DatabaseStats>;
  close(): Promise<void>;
}

export declare const queryDocuments: <T extends Record<string, any>>(
  docs: T[],
  filter?: Filter<T>,
  options?: QueryOptions<T>
) => T[];

export declare const operators: {
  matchFilter<T extends Record<string, any>>(doc: T, filter?: Filter<T>): boolean;
};

export default JsonDatabase;
