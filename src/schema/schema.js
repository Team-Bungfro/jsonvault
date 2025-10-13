"use strict";

const { cloneDeep } = require("../utils/objectUtils");

const SUPPORTED_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "array",
  "object",
  "any",
]);

const isPlainObject = (value) =>
  value != null &&
  typeof value === "object" &&
  (value.constructor === Object || Object.getPrototypeOf(value) === null);

const formatPath = (path) => (path ? path : "<root>");

const asRegExp = (pattern) => {
  if (!pattern) {
    return null;
  }
  if (pattern instanceof RegExp) {
    return pattern;
  }
  if (typeof pattern === "string") {
    return new RegExp(pattern);
  }
  throw new Error("Schema pattern must be a RegExp or string");
};

const normalizeRule = (rule, path) => {
  if (typeof rule === "string") {
    rule = { type: rule };
  }

  if (!isPlainObject(rule)) {
    throw new Error(`Invalid schema rule at "${path}"`);
  }

  const type = rule.type || "any";
  if (!SUPPORTED_TYPES.has(type)) {
    throw new Error(`Unsupported schema type "${type}" at "${path}"`);
  }

  const normalized = {
    type,
    required: Boolean(rule.required),
    allowNull: Boolean(rule.allowNull),
    defaultValue: Object.prototype.hasOwnProperty.call(rule, "default")
      ? rule.default
      : undefined,
    enum: Array.isArray(rule.enum) ? [...rule.enum] : null,
    min: rule.min ?? null,
    max: rule.max ?? null,
    minLength: rule.minLength ?? null,
    maxLength: rule.maxLength ?? null,
    pattern: asRegExp(rule.pattern),
    trim: Boolean(rule.trim),
    validate: typeof rule.validate === "function" ? rule.validate : null,
    transform: typeof rule.transform === "function" ? rule.transform : null,
    items: null,
    objectShape: null,
    allowAdditional:
      rule.allowAdditional === undefined ? true : Boolean(rule.allowAdditional),
    description: rule.description,
  };

  if (type === "array" && rule.items) {
    normalized.items = normalizeRule(rule.items, `${path}[]`);
  }

  if (type === "object" && rule.fields) {
    normalized.objectShape = normalizeSchema(
      {
        fields: rule.fields,
        allowAdditional:
          rule.allowAdditional === undefined
            ? true
            : Boolean(rule.allowAdditional),
      },
      path,
    );
  }

  return normalized;
};

const normalizeSchema = (definition, path = "") => {
  if (!definition) {
    definition = {};
  }

  let fields = definition.fields;
  if (!fields) {
    fields = definition;
  }

  if (!isPlainObject(fields)) {
    throw new Error("Schema fields must be an object");
  }

  const normalizedFields = {};
  for (const [key, rule] of Object.entries(fields)) {
    normalizedFields[key] = normalizeRule(
      rule,
      path ? `${path}.${key}` : key,
    );
  }

  return {
    fields: normalizedFields,
    allowAdditional:
      definition.allowAdditional === undefined
        ? true
        : Boolean(definition.allowAdditional),
  };
};

const isNumberValue = (value) =>
  typeof value === "number" && Number.isFinite(value);

const coerceDate = (value) => {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return null;
};

const deepEqual = (a, b) => {
  if (a === b) {
    return true;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (error) {
      return false;
    }
  }
  return false;
};

const applyDefault = (rule, context) => {
  if (!Object.prototype.hasOwnProperty.call(rule, "defaultValue")) {
    return undefined;
  }

  const source = rule.defaultValue;
  if (typeof source === "function") {
    return source(context);
  }
  return cloneDeep(source);
};

const assertCondition = (condition, path, message) => {
  if (!condition) {
    throw new Error(`Schema violation at "${formatPath(path)}": ${message}`);
  }
};

const validatePrimitive = (rule, value, path) => {
  if (value === null) {
    assertCondition(
      rule.allowNull,
      path,
      "value cannot be null (set allowNull to true to permit)",
    );
    return null;
  }

  switch (rule.type) {
    case "string": {
      assertCondition(typeof value === "string", path, "expected a string");
      const next = rule.trim ? value.trim() : value;
      if (rule.minLength != null) {
        assertCondition(
          next.length >= rule.minLength,
          path,
          `minimum length is ${rule.minLength}`,
        );
      }
      if (rule.maxLength != null) {
        assertCondition(
          next.length <= rule.maxLength,
          path,
          `maximum length is ${rule.maxLength}`,
        );
      }
      if (rule.pattern && !rule.pattern.test(next)) {
        assertCondition(false, path, "value does not match pattern");
      }
      return next;
    }
    case "number": {
      assertCondition(
        typeof value === "number" && Number.isFinite(value),
        path,
        "expected a finite number",
      );
      if (rule.min != null) {
        assertCondition(value >= rule.min, path, `minimum is ${rule.min}`);
      }
      if (rule.max != null) {
        assertCondition(value <= rule.max, path, `maximum is ${rule.max}`);
      }
      return value;
    }
    case "boolean": {
      assertCondition(typeof value === "boolean", path, "expected a boolean");
      return value;
    }
    case "date": {
      const date = coerceDate(value);
      assertCondition(
        date instanceof Date && !Number.isNaN(date.getTime()),
        path,
        "expected a Date, ISO string, or timestamp",
      );
      if (rule.min != null) {
        const minValue =
          rule.min instanceof Date ? rule.min.getTime() : Number(rule.min);
        assertCondition(
          date.getTime() >= minValue,
          path,
          `date must be on or after ${new Date(minValue).toISOString()}`,
        );
      }
      if (rule.max != null) {
        const maxValue =
          rule.max instanceof Date ? rule.max.getTime() : Number(rule.max);
        assertCondition(
          date.getTime() <= maxValue,
          path,
          `date must be on or before ${new Date(maxValue).toISOString()}`,
        );
      }
      return date;
    }
    case "any":
      return value;
    default:
      return value;
  }
};

const validateArray = (rule, value, context, path) => {
  assertCondition(Array.isArray(value), path, "expected an array");

  if (rule.minLength != null) {
    assertCondition(
      value.length >= rule.minLength,
      path,
      `minimum length is ${rule.minLength}`,
    );
  }

  if (rule.maxLength != null) {
    assertCondition(
      value.length <= rule.maxLength,
      path,
      `maximum length is ${rule.maxLength}`,
    );
  }

  if (!rule.items) {
    return value;
  }

  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    value[index] = validateRule(
      rule.items,
      value[index],
      context,
      itemPath,
    );
  }

  return value;
};

const validateObject = (shape, value, context, path) => {
  assertCondition(
    isPlainObject(value),
    path,
    "expected an object",
  );

  for (const [field, rule] of Object.entries(shape.fields)) {
    validateField(rule, value, field, context, path ? `${path}.${field}` : field);
  }

  if (!shape.allowAdditional) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(shape.fields, key)) {
        assertCondition(
          false,
          path ? `${path}.${key}` : key,
          "field is not allowed by schema",
        );
      }
    }
  }

  return value;
};

const validateRule = (rule, value, context, path) => {
  if (value === undefined) {
    return undefined;
  }

  if (rule.type === "object") {
    assertCondition(
      isPlainObject(value),
      path,
      "expected an object",
    );
    if (rule.objectShape) {
      return validateObject(rule.objectShape, value, context, path);
    }
    return value;
  }

  if (rule.type === "array") {
    return validateArray(rule, value, context, path);
  }

  return validatePrimitive(rule, value, path);
};

const validateField = (rule, target, key, context, path) => {
  let value = target[key];

  if (value === undefined) {
    const defaultValue = applyDefault(rule, { ...context, path });
    if (defaultValue !== undefined) {
      value = defaultValue;
      target[key] = value;
    }
  }

  if (value === undefined) {
    if (rule.required) {
      assertCondition(false, path, "field is required");
    }
    return;
  }

  value = validateRule(rule, value, context, path);

  if (rule.enum) {
    const match = rule.enum.some((option) => deepEqual(option, value));
    assertCondition(match, path, "value is not in the allowed set");
  }

  if (rule.validate) {
    const result = rule.validate(value, { ...context, path });
    if (result === false) {
      assertCondition(false, path, "custom validator returned false");
    }
    if (result !== undefined && result !== true) {
      value = result;
    }
  }

  if (rule.transform) {
    value = rule.transform(value, { ...context, path });
  }

  target[key] = value;
};

const createSchema = (definition) => {
  const normalized = normalizeSchema(definition);

  const validate = (document, context = {}) => {
    assertCondition(
      isPlainObject(document),
      "",
      "document must be a plain object",
    );

    for (const [field, rule] of Object.entries(normalized.fields)) {
      validateField(
        rule,
        document,
        field,
        { ...context, document },
        field,
      );
    }

    if (!normalized.allowAdditional) {
      const primaryKey =
        context.primaryKey ||
        (context.collection && context.collection.primaryKey) ||
        "_id";

      for (const key of Object.keys(document)) {
        if (key === primaryKey) {
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(normalized.fields, key)) {
          assertCondition(
            false,
            key,
            "field is not allowed by schema",
          );
        }
      }
    }

    return document;
  };

  return {
    definition: normalized,
    validate,
  };
};

module.exports = {
  createSchema,
};
