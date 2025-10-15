"use strict";

const fs = require("fs/promises");
const path = require("path");

const ensureDir = async (directory) => {
  await fs.mkdir(directory, { recursive: true });
};

const toLines = (input) => {
  if (!input) {
    return [];
  }
  return input.split("\n").filter((line) => line.trim().length > 0);
};

const parseLines = (input) => {
  const lines = Array.isArray(input) ? input : toLines(input);
  return lines.map((line) => JSON.parse(line));
};

const bufferLength = (value) => Buffer.byteLength(value, "utf8");

class FileChangeLog {
  constructor(options = {}) {
    if (!options.file) {
      throw new Error("FileChangeLog requires a file path");
    }
    this.file = path.resolve(options.file);
    this._options = {
      maxEntries:
        options.maxEntries && Number(options.maxEntries) > 0
          ? Number(options.maxEntries)
          : null,
      maxSize:
        options.maxSize && Number(options.maxSize) > 0
          ? Number(options.maxSize)
          : null,
      autoArchive: Boolean(options.autoArchive),
      archiveDirectory: options.archiveDirectory
        ? path.resolve(options.archiveDirectory)
        : null,
    };
    this._seq = 0;
    this._entryCount = 0;
    this._size = 0;
    this._initialized = false;
  }

  static async create(options = {}) {
    const log = new FileChangeLog(options);
    await log.init();
    return log;
  }

  get nextSequence() {
    return this._seq + 1;
  }

  async init() {
    if (this._initialized) {
      return;
    }
    const directory = path.dirname(this.file);
    await ensureDir(directory);

    try {
      const contents = await fs.readFile(this.file, "utf8");
      const lines = toLines(contents);
      const entries = parseLines(lines);
      if (entries.length > 0) {
        const [{ seq }] = entries.slice(-1);
        if (Number.isFinite(seq)) {
          this._seq = seq;
        }
      }
      this._entryCount = entries.length;
      this._size = bufferLength(contents);
      await this._enforceRetention({ lines });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await fs.writeFile(this.file, "", "utf8");
      this._entryCount = 0;
      this._size = 0;
    }

    this._initialized = true;
  }

  async append(event) {
    if (!this._initialized) {
      await this.init();
    }

    this._seq += 1;
    const payload = {
      seq: this._seq,
      ...event,
    };
    const line = `${JSON.stringify(payload)}\n`;
    await fs.appendFile(this.file, line, "utf8");
    this._entryCount += 1;
    this._size += bufferLength(line);
    await this._enforceRetention();
    return payload;
  }

  async read(options = {}) {
    if (!this._initialized) {
      await this.init();
    }
    const from = Number(options.from || 0);
    const limit = options.limit === undefined ? null : Number(options.limit);

    const contents = await fs.readFile(this.file, "utf8");
    const entries = parseLines(contents);
    if (!Number.isFinite(from) || from <= 0) {
      return this._applyLimit(entries, limit);
    }
    const tail = entries.filter((entry) => Number(entry.seq) >= from);
    return this._applyLimit(tail, limit);
  }

  async clear() {
    if (!this._initialized) {
      await this.init();
    }
    await fs.writeFile(this.file, "", "utf8");
    this._seq = 0;
    this._entryCount = 0;
    this._size = 0;
  }

  async close() {
    // no persistent handles to release
  }

  _applyLimit(entries, limit) {
    if (limit === null || Number.isNaN(limit) || limit <= 0) {
      return entries;
    }
    if (entries.length <= limit) {
      return entries;
    }
    return entries.slice(entries.length - limit);
  }

  async _enforceRetention(preloaded = {}) {
    const { maxEntries, maxSize } = this._options;

    if (!maxEntries && !maxSize) {
      return;
    }

    let lines = preloaded.lines;
    if (!lines) {
      const contents = await fs.readFile(this.file, "utf8");
      lines = toLines(contents);
      this._size = bufferLength(contents);
      this._entryCount = lines.length;
    }

    if (lines.length === 0) {
      this._entryCount = 0;
      this._size = 0;
      return;
    }

    let keepLines = [...lines];

    if (maxEntries && keepLines.length > maxEntries) {
      keepLines = keepLines.slice(keepLines.length - maxEntries);
    }

    if (maxSize) {
      const selected = [];
      let total = 0;
      for (let i = keepLines.length - 1; i >= 0; i -= 1) {
        const line = `${keepLines[i]}\n`;
        const length = bufferLength(line);
        if (selected.length > 0 && total + length > maxSize) {
          break;
        }
        selected.push(keepLines[i]);
        total += length;
        if (total >= maxSize) {
          break;
        }
      }
      keepLines = selected.reverse();
    }

    const removed = lines.slice(0, lines.length - keepLines.length);
    if (removed.length === 0 && keepLines.length === lines.length) {
      this._entryCount = keepLines.length;
      this._size = keepLines.length
        ? bufferLength(`${keepLines.join("\n")}\n`)
        : 0;
      return;
    }

    if (removed.length > 0 && this._options.autoArchive) {
      await this._archiveLines(removed);
    }

    const payload = keepLines.length ? `${keepLines.join("\n")}\n` : "";
    await fs.writeFile(this.file, payload, "utf8");
    this._entryCount = keepLines.length;
    this._size = bufferLength(payload);
  }

  async _archiveLines(lines) {
    if (!lines || lines.length === 0) {
      return;
    }
    const directory =
      this._options.archiveDirectory ||
      path.join(path.dirname(this.file), "archive");
    await ensureDir(directory);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveName = `log-${timestamp}-${this._seq}.jsonl`;
    const archivePath = path.join(directory, archiveName);
    const payload = `${lines.join("\n")}\n`;
    await fs.writeFile(archivePath, payload, "utf8");
  }
}

module.exports = FileChangeLog;
