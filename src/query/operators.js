"use strict";

const { getByPath } = require("../utils/objectUtils");
const { QueryError } = require("../errors");

const isOperatorObject = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.keys(value).some((key) => key.startsWith("$"));
};

const compareValues = (lhs, rhs) => {
  if (lhs === rhs) {
    return 0;
  }

  if (lhs == null) {
    return -1;
  }

  if (rhs == null) {
    return 1;
  }

  if (typeof lhs === "number" && typeof rhs === "number") {
    return lhs - rhs;
  }

  if (lhs instanceof Date && rhs instanceof Date) {
    return lhs.getTime() - rhs.getTime();
  }

  const left = JSON.stringify(lhs);
  const right = JSON.stringify(rhs);
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

const ensureArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
};

const scalarMatch = (docValue, expected) => {
  if (docValue === expected) {
    return true;
  }

  if (Array.isArray(docValue)) {
    return docValue.some((item) => scalarMatch(item, expected));
  }

  return false;
};

const normalizeModulo = (value, divisor) => {
  const remainder = value % divisor;
  return remainder < 0 ? remainder + Math.abs(divisor) : remainder;
};

const resolveType = (value) => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value instanceof Date) {
    return "date";
  }
  if (value instanceof RegExp) {
    return "regexp";
  }
  return typeof value;
};

const basicOperator = {
  $eq: (value, operand) => scalarMatch(value, operand),
  $ne: (value, operand) => !scalarMatch(value, operand),
  $gt: (value, operand) => compareValues(value, operand) > 0,
  $gte: (value, operand) => compareValues(value, operand) >= 0,
  $lt: (value, operand) => compareValues(value, operand) < 0,
  $lte: (value, operand) => compareValues(value, operand) <= 0,
  $in: (value, operand) =>
    ensureArray(operand).some((item) => scalarMatch(value, item)),
  $nin: (value, operand) =>
    !ensureArray(operand).some((item) => scalarMatch(value, item)),
  $exists: (value, operand) => {
    const exists = value !== undefined;
    return operand ? exists : !exists;
  },
  $regex: (value, operand, options) => {
    if (typeof operand === "string") {
      const flags = typeof options === "string" ? options : undefined;
      const regex = new RegExp(operand, flags);
      if (Array.isArray(value)) {
        return value.some((entry) => regex.test(String(entry)));
      }
      return regex.test(String(value));
    }

    if (operand instanceof RegExp) {
      if (Array.isArray(value)) {
        return value.some((entry) => operand.test(String(entry)));
      }
      return operand.test(String(value));
    }

    return false;
  },
  $size: (value, operand) => {
    if (!Array.isArray(value)) {
      return false;
    }
    return value.length === operand;
  },
  $contains: (value, operand) => {
    if (typeof value === "string") {
      return value.includes(operand);
    }
    if (Array.isArray(value)) {
      return value.some((item) => scalarMatch(item, operand));
    }
    return false;
  },
  $startsWith: (value, operand) => {
    if (typeof value === "string") {
      return value.startsWith(operand);
    }
    return false;
  },
  $endsWith: (value, operand) => {
    if (typeof value === "string") {
      return value.endsWith(operand);
    }
    return false;
  },
  $all: (value, operand) => {
    if (!Array.isArray(value)) {
      return false;
    }
    const expected = ensureArray(operand);
    return expected.every((item) =>
      value.some((entry) => scalarMatch(entry, item)),
    );
  },
  $elemMatch: (value, operand) => {
    if (!Array.isArray(value) || !operand || typeof operand !== "object") {
      return false;
    }
    return value.some((item) => matchSubFilter(item, operand));
  },
  $mod: (value, operand) => {
    if (typeof value !== "number") {
      return false;
    }
    const divisors = ensureArray(operand);
    if (divisors.length < 2) {
      return false;
    }
    const divisor = Number(divisors[0]);
    const expected = Number(divisors[1]);
    if (!Number.isFinite(divisor) || divisor === 0 || !Number.isFinite(expected)) {
      return false;
    }
    return normalizeModulo(value, divisor) === normalizeModulo(expected, divisor);
  },
  $type: (value, operand) => {
    const types = Array.isArray(operand) ? operand : [operand];
    return types.some((entry) => {
      const expected = String(entry).toLowerCase();
      return resolveType(value) === expected;
    });
  },
};

const applyOperators = (value, query) => {
  for (const [operator, operand] of Object.entries(query)) {
    if (operator === "$options") {
      continue;
    }

    if (operator === "$not") {
      if (operand instanceof RegExp) {
        if (basicOperator.$regex(value, operand)) {
          return false;
        }
        continue;
      }

      if (operand && typeof operand === "object" && isOperatorObject(operand)) {
        if (applyOperators(value, operand)) {
          return false;
        }
        continue;
      }

      if (scalarMatch(value, operand)) {
        return false;
      }
      continue;
    }

    const handler = basicOperator[operator];
    if (!handler) {
      throw new QueryError(`Unsupported operator "${operator}"`);
    }

    if (operator === "$regex") {
      const options = query.$options;
      if (!handler(value, operand, options)) {
        return false;
      }
    } else if (!handler(value, operand)) {
      return false;
    }
  }

  return true;
};

const matchSubFilter = (doc, filter) => {
  for (const [rawKey, criteria] of Object.entries(filter)) {
    if (rawKey === "$and") {
      if (!criteria.every((sub) => matchSubFilter(doc, sub))) {
        return false;
      }
      continue;
    }

    if (rawKey === "$or") {
      if (!criteria.some((sub) => matchSubFilter(doc, sub))) {
        return false;
      }
      continue;
    }

    if (rawKey === "$nor") {
      if (criteria.some((sub) => matchSubFilter(doc, sub))) {
        return false;
      }
      continue;
    }

    if (rawKey === "$not") {
      if (matchSubFilter(doc, criteria)) {
        return false;
      }
      continue;
    }

    const value = getByPath(doc, rawKey);
    if (isOperatorObject(criteria)) {
      if (!applyOperators(value, criteria)) {
        return false;
      }
    } else if (!scalarMatch(value, criteria)) {
      return false;
    }
  }

  return true;
};

const matchFilter = (doc, filter = {}) => {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }

  return matchSubFilter(doc, filter);
};

module.exports = {
  matchFilter,
  compareValues,
  isOperatorObject,
};
