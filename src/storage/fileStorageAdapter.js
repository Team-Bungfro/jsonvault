"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { getByPath } = require("../utils/objectUtils");

const DEFAULT_META = {
  version: 1,
  createdAt: null,
  updatedAt: null,
};

const defaultSerializer = {
  extension: "json",
  stringify: (data) => JSON.stringify(data, null, 2),
  parse: (str) => JSON.parse(str),
};

const ensureDir = async (directory) => {
  await fs.mkdir(directory, { recursive: true });
};

const atomicWriteFile = async (targetPath, payload) => {
  const tempFile = path.join(
    path.dirname(targetPath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random()}`,
  );

  await fs.writeFile(tempFile, payload, "utf8");
  await fs.rename(tempFile, targetPath);
};

const removeDirIfExists = async (dir) => {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
};

const coerceRangeValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

class FileStorageAdapter {
  constructor(options = {}) {
    this.directory =
      options.directory ||
      path.resolve(process.cwd(), "json-data");

    this.collectionsDir = path.join(this.directory, "collections");
    this.metaFile = path.join(this.directory, "meta.json");
    this.backupDir =
      options.backupDir || path.join(this.directory, "backups");
    this.serializer = options.serializer || defaultSerializer;
    this.collectionSuffix = `.collection.${this.serializer.extension}`;
    this.chunkExtension = this.serializer.extension;
  }

  async init() {
    await ensureDir(this.directory);
    await ensureDir(this.collectionsDir);
    await ensureDir(this.backupDir);

    try {
      await fs.access(this.metaFile);
    } catch (error) {
      const now = new Date().toISOString();
      const meta = {
        ...DEFAULT_META,
        createdAt: now,
        updatedAt: now,
      };
      await atomicWriteFile(this.metaFile, JSON.stringify(meta, null, 2));
    }
  }

  async readMeta() {
    try {
      const data = await fs.readFile(this.metaFile, "utf8");
      return JSON.parse(data);
    } catch (error) {
      return { ...DEFAULT_META };
    }
  }

  async writeMeta(meta) {
    const nextMeta = {
      ...DEFAULT_META,
      ...meta,
      updatedAt: new Date().toISOString(),
    };

    await atomicWriteFile(this.metaFile, JSON.stringify(nextMeta, null, 2));
    return nextMeta;
  }

  async listCollections() {
    const entries = await fs.readdir(this.collectionsDir, {
      withFileTypes: true,
    });

    return entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(this.collectionSuffix),
      )
      .map((entry) => entry.name.replace(this.collectionSuffix, ""));
  }

  collectionPath(name) {
    return path.join(this.collectionsDir, `${name}${this.collectionSuffix}`);
  }

  chunkDirectory(name) {
    return path.join(this.collectionsDir, `${name}.chunks`);
  }

  async readCollection(name) {
    const filePath = this.collectionPath(name);

    try {
      const payload = await fs.readFile(filePath, "utf8");
      const parsed = this.serializer.parse(payload);

      let documents = parsed.documents || [];
      if (!documents.length && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
        const chunkDir = this.chunkDirectory(name);
        documents = [];
        for (const chunk of parsed.chunks) {
          const chunkPath = path.join(chunkDir, chunk.file);
          try {
            const raw = await fs.readFile(chunkPath, "utf8");
            documents.push(...this.serializer.parse(raw));
          } catch (error) {
            if (error.code === "ENOENT") {
              continue;
            }
            throw error;
          }
        }
      }

      return {
        name: parsed.name,
        documents,
        indexes: parsed.indexes || {},
        options: parsed.options || {},
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          name,
          documents: [],
          indexes: {},
          options: {},
        };
      }
      throw error;
    }
  }

  async writeCollection(name, payload) {
    const filePath = this.collectionPath(name);
    const chunkDir = this.chunkDirectory(name);
    const documents = payload.documents || [];
    const options = payload.options || {};
    const partition = options.partition || null;

    let chunksMeta = null;

    if (partition && partition.chunkSize && documents.length > partition.chunkSize) {
      await removeDirIfExists(chunkDir);
      await ensureDir(chunkDir);

      chunksMeta = [];
      let index = 0;
      let offset = 0;
      while (offset < documents.length) {
        const slice = documents.slice(offset, offset + partition.chunkSize);
        index += 1;
        const file = `${name}.chunk-${String(index).padStart(4, "0")}.${this.chunkExtension}`;
        const chunkPath = path.join(chunkDir, file);
        await atomicWriteFile(chunkPath, this.serializer.stringify(slice));

        let min = null;
        let max = null;
        if (partition.key) {
          for (const doc of slice) {
            const value = coerceRangeValue(getByPath(doc, partition.key));
            if (value == null) {
              continue;
            }
            if (min === null || value < min) {
              min = value;
            }
            if (max === null || value > max) {
              max = value;
            }
          }
        }

        const start = offset;
        const end = offset + slice.length;
        chunksMeta.push({ file, count: slice.length, start, end, min, max });
        offset = end;
      }
    } else {
      // remove old chunk files if they exist
      await removeDirIfExists(chunkDir);
    }

    const wrapped = {
      name,
      documents: chunksMeta ? [] : documents,
      indexes: payload.indexes || {},
      options,
      chunks: chunksMeta,
    };

    await atomicWriteFile(filePath, this.serializer.stringify(wrapped));
  }

  async deleteCollection(name) {
    const filePath = this.collectionPath(name);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async backup(destinationDir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const targetDir =
      destinationDir ||
      path.join(this.backupDir, `backup-${timestamp}`);

    await ensureDir(targetDir);

    const files = await fs.readdir(this.collectionsDir);
    for (const file of files) {
      const source = path.join(this.collectionsDir, file);
      const destination = path.join(targetDir, file);
      const content = await fs.readFile(source, "utf8");
      await atomicWriteFile(destination, content);
    }

    const meta = await fs.readFile(this.metaFile, "utf8");
    await atomicWriteFile(path.join(targetDir, "meta.json"), meta);

    return targetDir;
  }

  async createTempWorkspace(prefix = "jsondb") {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    return tempDir;
  }
}

module.exports = FileStorageAdapter;
