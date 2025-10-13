"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const DEFAULT_META = {
  version: 1,
  createdAt: null,
  updatedAt: null,
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

class FileStorageAdapter {
  constructor(options = {}) {
    this.directory =
      options.directory ||
      path.resolve(process.cwd(), "json-data");

    this.collectionsDir = path.join(this.directory, "collections");
    this.metaFile = path.join(this.directory, "meta.json");
    this.backupDir =
      options.backupDir || path.join(this.directory, "backups");
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
      .filter((entry) => entry.isFile() && entry.name.endsWith(".collection.json"))
      .map((entry) => entry.name.replace(".collection.json", ""));
  }

  collectionPath(name) {
    return path.join(this.collectionsDir, `${name}.collection.json`);
  }

  async readCollection(name) {
    const filePath = this.collectionPath(name);

    try {
      const payload = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(payload);
      return {
        name: parsed.name,
        documents: parsed.documents || [],
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
    const wrapped = {
      name,
      documents: payload.documents || [],
      indexes: payload.indexes || {},
      options: payload.options || {},
    };

    await atomicWriteFile(filePath, JSON.stringify(wrapped, null, 2));
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
