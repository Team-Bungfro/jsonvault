"use strict";

const { getByPath } = require("../utils/objectUtils");
const { QueryError, InvalidArgumentError } = require("../errors");

const comparison = (lhs, op, rhs) => {
  switch (op) {
    case ">":
      return lhs > rhs;
    case ">=":
      return lhs >= rhs;
    case "<":
      return lhs < rhs;
    case "<=":
      return lhs <= rhs;
    case "==":
      return lhs === rhs;
    case "!=":
      return lhs !== rhs;
    default:
      throw new QueryError(`Unsupported operator ${op}`);
  }
};

const parseLiteral = (raw) => {
  const value = raw.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  if (/^null$/i.test(value)) {
    return null;
  }
  const num = Number(value);
  if (!Number.isNaN(num)) {
    return num;
  }
  return value;
};

const expressionRegex = /^\$\.([\w]+)\[\?\((.+)\)\]$/;

const splitTopLevel = (input, delimiter) => {
  const parts = [];
  let depth = 0;
  let current = "";
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quote) {
      current += char;
      if (char === quote && input[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (depth === 0 && input.slice(i, i + delimiter.length) === delimiter) {
      parts.push(current.trim());
      current = "";
      i += delimiter.length - 1;
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
};

const parseCondition = (input) => {
  let condition = input.trim();
  if (condition.startsWith("(") && condition.endsWith(")")) {
    const inner = condition.slice(1, -1).trim();
    if (inner) {
      condition = inner;
    }
  }

  const orParts = splitTopLevel(condition, "||");
  if (orParts.length > 1) {
    return {
      type: "or",
      conditions: orParts.map(parseCondition),
    };
  }

  const andParts = splitTopLevel(condition, "&&");
  if (andParts.length > 1) {
    return {
      type: "and",
      conditions: andParts.map(parseCondition),
    };
  }

  const comparisonRegex = /^@\.([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;
  const match = comparisonRegex.exec(condition);
  if (!match) {
    throw new QueryError(`Unsupported condition: ${condition}`);
  }

  const [, field, operator, rawValue] = match;
  return {
    type: "comparison",
    field,
    operator,
    value: parseLiteral(rawValue),
  };
};

const buildPredicate = (node) => {
  if (!node) {
    return () => true;
  }

  if (node.type === "comparison") {
    return (doc) => {
      const current = getByPath(doc, node.field);
      return comparison(current, node.operator, node.value);
    };
  }

  if (node.type === "and") {
    const predicates = node.conditions.map(buildPredicate);
    return (doc) => predicates.every((fn) => fn(doc));
  }

  if (node.type === "or") {
    const predicates = node.conditions.map(buildPredicate);
    return (doc) => predicates.some((fn) => fn(doc));
  }

  throw new QueryError("Unknown condition node");
};

const compileExpression = (expression) => {
  const match = expressionRegex.exec(expression.trim());
  if (!match) {
    throw new QueryError(
      "Unsupported expression. Expected format like '$.collection[?(@.field > 10)]'",
    );
  }

  const [, collection, rawCondition] = match;
  const conditionNode = parseCondition(rawCondition);
  const predicate = buildPredicate(conditionNode);

  return {
    type: "expression",
    collection,
    expression,
    predicate,
    async *execute(db) {
      const coll = db.collection(collection);
      for await (const doc of coll.stream()) {
        if (predicate(doc)) {
          yield doc;
        }
      }
    },
  };
};

const compileFilter = (spec) => {
  if (!spec.collection) {
    throw new InvalidArgumentError("compile({ collection }) requires a collection name");
  }

  const collection = spec.collection;
  const filter = spec.filter || {};
  const baseOptions = spec.options || {};

  return {
    type: "filter",
    collection,
    filter,
    options: baseOptions,
    async *execute(db, options = {}) {
      const coll = db.collection(collection);
      const effective = { ...baseOptions, ...options };
      for await (const doc of coll.stream(filter, effective)) {
        yield doc;
      }
    },
    explain(db) {
      return db.collection(collection).explain(filter);
    },
  };
};

const compileQuery = (input) => {
  if (typeof input === "string") {
    return compileExpression(input);
  }

  if (input && typeof input === "object") {
    return compileFilter(input);
  }

  throw new InvalidArgumentError("Unsupported compile() input");
};

module.exports = {
  compileQuery,
};
