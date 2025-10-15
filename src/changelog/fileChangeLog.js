"use strict";

const fs = require("fs/promises");
const path = require("path");

const ensureDir = async (directory) => {
  await fs.mkdir(directory, { recursive: true });
};

const parseLines = (input) => {
  if (!input) {
    return [];
  }
  const lines = input.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line));
};

class FileChangeLog {
  constructor(options = {}) {
    if (!options.file) {
      throw new Error("FileChangeLog requires a file path");
    }
    this.file = path.resolve(options.file);
    this._seq = 0;
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
      const entries = parseLines(contents);
      if (entries.length > 0) {
        const [{ seq }] = entries.slice(-1);
        if (Number.isFinite(seq)) {
          this._seq = seq;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await fs.writeFile(this.file, "", "utf8");
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
    return payload;
  }

  async read(options = {}) {
    if (!this._initialized) {
      await this.init();
    }
    const from = Number(options.from || 0);

    const contents = await fs.readFile(this.file, "utf8");
    const entries = parseLines(contents);
    if (!Number.isFinite(from) || from <= 0) {
      return entries;
    }
    return entries.filter((entry) => Number(entry.seq) >= from);
  }

  async clear() {
    if (!this._initialized) {
      await this.init();
    }
    await fs.writeFile(this.file, "", "utf8");
    this._seq = 0;
  }

  async close() {
    // no persistent handles to release
  }
}

module.exports = FileChangeLog;
