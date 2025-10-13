"use strict";

const { randomBytes, createCipheriv, createDecipheriv, createHash } = require("crypto");
const { cloneDeep, getByPath, setByPath, unsetByPath } = require("../utils/objectUtils");

const ENCRYPTED_FLAG = "__jsonvaultEncrypted";
const DEFAULT_ALGORITHM = "aes-256-gcm";

const deriveKey = (secret) =>
  createHash("sha256").update(String(secret)).digest();

const isEncryptedPayload = (value) =>
  value &&
  typeof value === "object" &&
  value[ENCRYPTED_FLAG] === true &&
  typeof value.iv === "string" &&
  typeof value.tag === "string" &&
  typeof value.value === "string";

const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
};

const encryptValue = (value, key, algorithm) => {
  if (value === undefined) {
    return undefined;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    [ENCRYPTED_FLAG]: true,
    alg: algorithm,
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    value: payload.toString("base64"),
  };
};

const decryptValue = (payload, key) => {
  if (!isEncryptedPayload(payload)) {
    return payload;
  }

  const { alg, iv, tag, value } = payload;
  const algorithm = alg || DEFAULT_ALGORITHM;
  const decipher = createDecipheriv(
    algorithm,
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(value, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(decrypted);
};

const createFieldEncryption = (config = {}) => {
  if (!config.secret) {
    throw new Error("Encryption requires a secret");
  }

  const fields = ensureArray(config.fields).filter(Boolean);
  if (fields.length === 0) {
    throw new Error("Encryption requires at least one field");
  }

  const algorithm = config.algorithm || DEFAULT_ALGORITHM;
  const key = deriveKey(config.secret);

  const encryptDocument = (doc) => {
    const clone = cloneDeep(doc);
    for (const field of fields) {
      const current = getByPath(clone, field);
      if (current === undefined) {
        continue;
      }

      const encrypted = encryptValue(current, key, algorithm);
      if (encrypted === undefined) {
        unsetByPath(clone, field);
      } else {
        setByPath(clone, field, encrypted);
      }
    }
    return clone;
  };

  const decryptDocument = (doc) => {
    const clone = cloneDeep(doc);
    for (const field of fields) {
      const current = getByPath(clone, field);
      if (current === undefined) {
        continue;
      }

      const decrypted = decryptValue(current, key);
      if (decrypted === undefined) {
        unsetByPath(clone, field);
      } else {
        setByPath(clone, field, decrypted);
      }
    }
    return clone;
  };

  return {
    algorithm,
    fields,
    encryptDocument,
    decryptDocument,
  };
};

module.exports = {
  createFieldEncryption,
  ENCRYPTED_FLAG,
};
