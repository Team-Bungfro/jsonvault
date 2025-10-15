"use strict";

const { cloneDeep, getByPath, setByPath } = require("../utils/objectUtils");
const { compareValues, matchFilter } = require("../query/operators");

const PARAM_MARKER = "__jsonvault_param_";

const KEYWORDS = new Set(["AND", "OR", "BETWEEN", "IN", "IS", "NOT", "NULL", "LIKE"]);

const TRUTHY_KEYWORDS = new Map([
  ["TRUE", true],
  ["FALSE", false],
]);

const AGGREGATE_FACTORIES = {
  SUM() {
    return {
      total: 0,
      update(value) {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          this.total += num;
        }
      },
      finalize() {
        return this.total;
      },
    };
  },
  AVG() {
    return {
      total: 0,
      count: 0,
      update(value) {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          this.total += num;
          this.count += 1;
        }
      },
      finalize() {
        if (this.count === 0) {
          return null;
        }
        return this.total / this.count;
      },
    };
  },
  MIN() {
    return {
      value: null,
      hasValue: false,
      update(value) {
        if (value === undefined || value === null) {
          return;
        }
        if (!this.hasValue || compareValues(value, this.value) < 0) {
          this.value = value;
          this.hasValue = true;
        }
      },
      finalize() {
        return this.hasValue ? this.value : null;
      },
    };
  },
  MAX() {
    return {
      value: null,
      hasValue: false,
      update(value) {
        if (value === undefined || value === null) {
          return;
        }
        if (!this.hasValue || compareValues(value, this.value) > 0) {
          this.value = value;
          this.hasValue = true;
        }
      },
      finalize() {
        return this.hasValue ? this.value : null;
      },
    };
  },
  COUNT() {
    return {
      count: 0,
      update(value, includeNull = false) {
        if (includeNull || (value !== undefined && value !== null)) {
          this.count += 1;
        }
      },
      finalize() {
        return this.count;
      },
    };
  },
};

const splitOnComma = (input) => {
  const parts = [];
  let current = "";
  let depth = 0;
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

    if (char === "'" || char === "\"") {
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

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
};

const classifyBuffer = (buffer) => {
  if (!buffer) {
    return null;
  }

  const upper = buffer.toUpperCase();
  if (KEYWORDS.has(upper)) {
    return { type: "keyword", value: upper };
  }

  if (TRUTHY_KEYWORDS.has(upper)) {
    return { type: "literal", value: TRUTHY_KEYWORDS.get(upper) };
  }

  if (upper === "NULL") {
    return { type: "literal", value: null };
  }

  if (/^-?\d+(\.\d+)?$/.test(buffer)) {
    return { type: "literal", value: Number(buffer) };
  }

  return { type: "identifier", value: buffer };
};

const tokenize = (input) => {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "'" || char === "\"") {
      const quote = char;
      let value = "";
      i += 1;

      while (i < input.length) {
        const current = input[i];
        if (current === quote) {
          if (input[i + 1] === quote) {
            value += quote;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += current;
        i += 1;
      }

      tokens.push({ type: "literal", value });
      continue;
    }

    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ type: char });
      i += 1;
      continue;
    }

    const potentialParam = input.slice(i).match(new RegExp(`^${PARAM_MARKER}(\\d+)__`));
    if (potentialParam) {
      tokens.push({ type: "param", index: Number(potentialParam[1]) });
      i += potentialParam[0].length;
      continue;
    }

    const twoCharOperator = input.slice(i, i + 2);
    if (
      twoCharOperator === ">=" ||
      twoCharOperator === "<=" ||
      twoCharOperator === "<>" ||
      twoCharOperator === "!="
    ) {
      tokens.push({ type: "operator", value: twoCharOperator });
      i += 2;
      continue;
    }

    if (char === "=" || char === ">" || char === "<") {
      tokens.push({ type: "operator", value: char });
      i += 1;
      continue;
    }

    let buffer = "";
    while (i < input.length) {
      const current = input[i];
      if (
        /\s/.test(current) ||
        current === "(" ||
        current === ")" ||
        current === "," ||
        current === "'" ||
        current === "\"" ||
        current === "=" ||
        current === ">" ||
        current === "<"
      ) {
        break;
      }
      buffer += current;
      i += 1;
    }

    const classified = classifyBuffer(buffer);
    if (classified) {
      tokens.push(classified);
    }
  }

  return tokens;
};

const readValueToken = (tokens, index, params) => {
  const token = tokens[index];
  if (!token) {
    throw new Error("Expected value in WHERE clause");
  }

  if (token.type === "literal") {
    return { value: token.value, index: index + 1 };
  }

  if (token.type === "param") {
    return { value: params[token.index], index: index + 1 };
  }

  if (token.type === "identifier") {
    return { value: token.value, index: index + 1 };
  }

  if (token.type === "keyword" && token.value === "NULL") {
    return { value: null, index: index + 1 };
  }

  throw new Error("Unsupported value in WHERE clause");
};

const parseBetween = (field, tokens, index, params) => {
  const start = readValueToken(tokens, index, params);
  const afterStart = tokens[start.index];

  if (!afterStart || afterStart.type !== "keyword" || afterStart.value !== "AND") {
    throw new Error("BETWEEN requires 'AND'");
  }

  const end = readValueToken(tokens, start.index + 1, params);
  return {
    clause: {
      [field]: {
        $gte: start.value,
        $lte: end.value,
      },
    },
    nextIndex: end.index,
  };
};

const parseInList = (field, tokens, index, params) => {
  const values = [];
  let cursor = index;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token) {
      throw new Error("Unexpected end of IN list");
    }
    if (token.type === ")") {
      return {
        clause: {
          [field]: { $in: values },
        },
        nextIndex: cursor + 1,
      };
    }

    if (token.type === ",") {
      cursor += 1;
      continue;
    }

    const { value, index: nextIndex } = readValueToken(tokens, cursor, params);
    values.push(value);
    cursor = nextIndex;
  }
  throw new Error("IN list missing closing parenthesis");
};

const parseComparison = (field, operator, tokens, index, params) => {
  const valueToken = readValueToken(tokens, index, params);
  const value = valueToken.value;
  let clause;

  switch (operator) {
    case "=":
      clause = { [field]: value };
      break;
    case "!=":
    case "<>":
      clause = { [field]: { $ne: value } };
      break;
    case ">":
      clause = { [field]: { $gt: value } };
      break;
    case ">=":
      clause = { [field]: { $gte: value } };
      break;
    case "<":
      clause = { [field]: { $lt: value } };
      break;
    case "<=":
      clause = { [field]: { $lte: value } };
      break;
    default:
      throw new Error(`Unsupported operator '${operator}'`);
  }

  return {
    clause,
    nextIndex: valueToken.index,
  };
};

const parseConditionTokens = (tokens, startIndex, params) => {
  const fieldToken = tokens[startIndex];
  if (!fieldToken || fieldToken.type !== "identifier") {
    throw new Error("Expected field name in WHERE clause");
  }
  const field = fieldToken.value;
  let index = startIndex + 1;
  const token = tokens[index];

  if (!token) {
    throw new Error("Unexpected end of WHERE clause");
  }

  if (token.type === "keyword" && token.value === "BETWEEN") {
    const between = parseBetween(field, tokens, index + 1, params);
    return { clause: between.clause, nextIndex: between.nextIndex };
  }

  if (token.type === "keyword" && token.value === "IN") {
    const afterIn = tokens[index + 1];
    if (!afterIn || afterIn.type !== "(") {
      throw new Error("IN clause must start with '('");
    }
    const parsed = parseInList(field, tokens, index + 2, params);
    return { clause: parsed.clause, nextIndex: parsed.nextIndex };
  }

  if (token.type === "operator") {
    return parseComparison(field, token.value, tokens, index + 1, params);
  }

  throw new Error(`Unsupported WHERE condition near '${field}'`);
};

const parseWhere = (input, params) => {
  if (!input) {
    return null;
  }

  const tokens = tokenize(input);
  const clauses = [];
  let index = 0;

  while (index < tokens.length) {
    const { clause, nextIndex } = parseConditionTokens(tokens, index, params);
    clauses.push(clause);
    index = nextIndex;

    if (index >= tokens.length) {
      break;
    }

    const separator = tokens[index];
    if (
      separator.type === "keyword" &&
      separator.value === "AND"
    ) {
      index += 1;
      continue;
    }
    throw new Error("Only AND is supported between WHERE conditions");
  }

  if (clauses.length === 0) {
    return null;
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return { $and: clauses };
};

const parseCollectionRef = (input) => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Collection reference cannot be empty");
  }

  const match = /^([A-Za-z0-9_]+)(?:\s+(?:AS\s+)?([A-Za-z0-9_]+))?$/i.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid collection reference "${input}"`);
  }

  const collection = match[1];
  const alias = match[2] || collection;
  return { collection, alias };
};

const parseQualifiedField = (input) => {
  const trimmed = input.trim();
  const parts = trimmed.split(".");
  if (parts.length < 2) {
    throw new Error(`Expected qualified field (alias.field) but received "${input}"`);
  }
  const [alias, ...pathParts] = parts;
  return { alias, path: pathParts.join(".") };
};

const parseJoinClause = (input) => {
  const segments = input.split(/\s+ON\s+/i);
  if (segments.length !== 2) {
    throw new Error("JOIN clause must include ON <left> = <right>");
  }

  const target = parseCollectionRef(segments[0]);
  const condition = segments[1].trim();
  const match = /^([A-Za-z0-9_.]+)\s*=\s*([A-Za-z0-9_.]+)$/.exec(condition);
  if (!match) {
    throw new Error("Only equality JOIN conditions are supported");
  }

  const left = parseQualifiedField(match[1]);
  const right = parseQualifiedField(match[2]);

  return {
    collection: target.collection,
    alias: target.alias,
    condition: {
      left,
      right,
    },
  };
};

const parseFromClause = (input) => {
  const segments = input.split(/\s+JOIN\s+/i);
  if (segments.length === 0) {
    throw new Error("FROM clause cannot be empty");
  }

  const base = parseCollectionRef(segments[0]);
  const joins = [];

  if (segments.length > 2) {
    throw new Error("Only a single JOIN is supported at this time");
  }

  if (segments.length === 2) {
    const joinClause = segments[1];
    joins.push(parseJoinClause(joinClause));
  }

  return { base, joins };
};

const parseSelectExpression = (expression) => {
  let raw = expression.trim();
  let alias = null;

  const asMatch = raw.match(/\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (asMatch) {
    alias = asMatch[1];
    raw = raw.slice(0, asMatch.index).trim();
  } else {
    const parts = raw.split(/\s+/);
    if (parts.length > 1) {
      alias = parts.pop();
      raw = parts.join(" ");
    }
  }

  const aggregateMatch = raw.match(/^(SUM|AVG|MIN|MAX|COUNT)\s*\(\s*(\*|[\w.*]+)\s*\)$/i);
  if (aggregateMatch) {
    const func = aggregateMatch[1].toUpperCase();
    const field = aggregateMatch[2] === "*" ? "*" : aggregateMatch[2];
    return {
      type: "aggregate",
      func,
      field,
      alias: alias || `${func.toLowerCase()}_${field === "*" ? "all" : field.replace(/\W+/g, "_")}`,
    };
  }

  if (raw === "*") {
    return {
      type: "wildcard",
    };
  }

  return {
    type: "field",
    field: raw,
    alias: alias || raw,
  };
};

const parseOrderBy = (input) => {
  if (!input) {
    return [];
  }

  return splitOnComma(input).map((segment) => {
    const parts = segment.trim().split(/\s+/);
    const field = parts[0];
    const direction = parts[1] ? parts[1].toUpperCase() : "ASC";
    return {
      field,
      direction: direction === "DESC" ? -1 : 1,
    };
  });
};

const normalizeSqlInput = (strings, values) => {
  if (typeof strings === "string") {
    return {
      sql: strings,
      params: Array.isArray(values) ? values : [],
    };
  }

  if (!Array.isArray(strings) || typeof strings.raw === "undefined") {
    throw new Error("db.sql requires a template string or raw SQL string");
  }

  let sql = "";
  const params = [];

  for (let i = 0; i < strings.length; i += 1) {
    sql += strings[i];
    if (i < values.length) {
      sql += `${PARAM_MARKER}${params.length}__`;
      params.push(values[i]);
    }
  }

  return { sql, params };
};

const findClauseIndex = (upper, fromIndex, candidates) => {
  let nextIndex = upper.length;

  for (const candidate of candidates) {
    const index = upper.indexOf(candidate, fromIndex);
    if (index !== -1 && index < nextIndex) {
      nextIndex = index;
    }
  }

  return nextIndex;
};

const parseSqlStatement = (sql, params) => {
  const trimmed = sql.trim().replace(/;$/, "");
  const upper = trimmed.toUpperCase();

  if (!upper.startsWith("SELECT ")) {
    throw new Error("Only SELECT statements are supported");
  }

  const fromIndex = upper.indexOf(" FROM ");
  if (fromIndex === -1) {
    throw new Error("SELECT statement must include FROM clause");
  }

  const selectPart = trimmed.slice("SELECT ".length, fromIndex).trim();
  let cursor = fromIndex + " FROM ".length;

  const clauseCandidates = [" WHERE ", " GROUP BY ", " HAVING ", " ORDER BY ", " LIMIT "];
  const nextClauseIndex = findClauseIndex(upper, cursor, clauseCandidates);
  const fromPart = trimmed.slice(cursor, nextClauseIndex).trim();
  if (!fromPart) {
    throw new Error("FROM clause must specify a collection");
  }

  cursor = nextClauseIndex;

  let wherePart = null;
  let groupPart = null;
  let havingPart = null;
  let orderPart = null;
  let limitPart = null;

  while (cursor < trimmed.length) {
    const remainingUpper = upper.slice(cursor);
    if (remainingUpper.startsWith(" WHERE ")) {
      const start = cursor + " WHERE ".length;
      const end = findClauseIndex(upper, start, [" GROUP BY ", " HAVING ", " ORDER BY ", " LIMIT "]);
      wherePart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (remainingUpper.startsWith(" GROUP BY ")) {
      const start = cursor + " GROUP BY ".length;
      const end = findClauseIndex(upper, start, [" HAVING ", " ORDER BY ", " LIMIT "]);
      groupPart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (remainingUpper.startsWith(" HAVING ")) {
      const start = cursor + " HAVING ".length;
      const end = findClauseIndex(upper, start, [" ORDER BY ", " LIMIT "]);
      havingPart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (remainingUpper.startsWith(" ORDER BY ")) {
      const start = cursor + " ORDER BY ".length;
      const end = findClauseIndex(upper, start, [" LIMIT "]);
      orderPart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (remainingUpper.startsWith(" LIMIT ")) {
      const start = cursor + " LIMIT ".length;
      limitPart = trimmed.slice(start).trim();
      cursor = trimmed.length;
      continue;
    }
    break;
  }

  const selectExpressions = splitOnComma(selectPart).map(parseSelectExpression);
  const fromSpec = parseFromClause(fromPart);
  const hasWildcard = selectExpressions.some((expr) => expr.type === "wildcard");
  const aggregates = selectExpressions.filter((expr) => expr.type === "aggregate");
  const isAggregate = aggregates.length > 0;

  if (hasWildcard && isAggregate) {
    throw new Error("Cannot mix '*' with aggregate expressions");
  }

  const fields = selectExpressions.filter((expr) => expr.type === "field");
  let projection = null;
  if (!isAggregate && fromSpec.joins.length === 0 && fields.length > 0) {
    projection = {};
    fields.forEach((expr) => {
      if (!expr.field.includes(".")) {
        projection[expr.field] = 1;
      }
    });
  }

  if (fromSpec.joins.length > 0 && hasWildcard) {
    throw new Error("SELECT * is not supported with JOIN queries");
  }

  const filter = parseWhere(wherePart, params);
  const having = parseWhere(havingPart, params);
  const groupBy = groupPart ? splitOnComma(groupPart).map((entry) => entry.trim()).filter(Boolean) : [];
  const orderBy = parseOrderBy(orderPart);
  const limit = limitPart ? Number(limitPart) : null;

  if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
    throw new Error("LIMIT must be a non-negative number");
  }

  return {
    collection: fromSpec.base.collection,
    baseAlias: fromSpec.base.alias,
    joins: fromSpec.joins,
    selectExpressions,
    hasWildcard,
    isAggregate,
    projection,
    filter,
    having,
    groupBy,
    orderBy,
    limit,
  };
};

const resolveFieldFromContext = (context, field, baseAlias) => {
  if (!field) {
    return undefined;
  }
  const parts = field.split(".");
  let alias = baseAlias;
  let pathParts = parts;

  if (context.aliases.has(parts[0])) {
    alias = parts[0];
    pathParts = parts.slice(1);
  }

  const doc = context.aliases.get(alias);
  if (!doc) {
    return undefined;
  }

  if (pathParts.length === 0) {
    return doc;
  }

  return getByPath(doc, pathParts.join("."));
};

const applyFieldSelection = (contexts, selectExpressions, baseAlias) =>
  contexts.map((context) => {
    const row = {};
    for (const expr of selectExpressions) {
      if (expr.type !== "field") {
        continue;
      }
      const value = resolveFieldFromContext(context, expr.field, baseAlias);
      setByPath(row, expr.alias, value);
    }
    return row;
  });

const sortResults = (rows, orderBy) => {
  if (!orderBy || orderBy.length === 0) {
    return rows;
  }

  return rows.sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const lhs = getByPath(a, field);
      const rhs = getByPath(b, field);
      const comparison = compareValues(lhs, rhs);
      if (comparison !== 0) {
        return direction < 0 ? -comparison : comparison;
      }
    }
    return 0;
  });
};

const aggregateDocuments = (contexts, spec) => {
  const groups = new Map();
  const hasGroup = spec.groupBy.length > 0;

  for (const context of contexts) {
    const keyValues = hasGroup
      ? spec.groupBy.map((field) => resolveFieldFromContext(context, field, spec.baseAlias))
      : ['__all__'];
    const key = JSON.stringify(keyValues);

    if (!groups.has(key)) {
      groups.set(key, {
        keyValues,
        contexts: [],
        aggregates: spec.selectExpressions.map((expr) => {
          if (expr.type !== 'aggregate') {
            return null;
          }
          const factory = AGGREGATE_FACTORIES[expr.func];
          if (!factory) {
            throw new Error(`Unsupported aggregate function '${expr.func}'`);
          }
          return {
            expr,
            state: factory(),
          };
        }),
      });
    }

    const entry = groups.get(key);
    entry.contexts.push(context);

    entry.aggregates.forEach((aggregate) => {
      if (!aggregate) {
        return;
      }
      const targetValue =
        aggregate.expr.field === '*'
          ? context.aliases.get(spec.baseAlias)
          : resolveFieldFromContext(context, aggregate.expr.field, spec.baseAlias);

      if (aggregate.expr.func === 'COUNT') {
        const includeNull = aggregate.expr.field === '*';
        aggregate.state.update(targetValue, includeNull);
      } else {
        aggregate.state.update(targetValue);
      }
    });
  }

  const rows = [];
  for (const entry of groups.values()) {
    const row = {};

    entry.aggregates.forEach((aggregate) => {
      if (!aggregate) {
        return;
      }
      setByPath(row, aggregate.expr.alias, aggregate.state.finalize());
    });

    spec.selectExpressions.forEach((expr) => {
      if (expr.type === 'aggregate') {
        return;
      }

      if (spec.groupBy.includes(expr.field)) {
        const index = spec.groupBy.indexOf(expr.field);
        setByPath(row, expr.alias, entry.keyValues[index]);
        return;
      }

      const sample = entry.contexts[0];
      const value = resolveFieldFromContext(sample, expr.field, spec.baseAlias);
      setByPath(row, expr.alias, value);
    });

    rows.push(row);
  }

  return rows;
};

const buildContexts = async (db, spec) => {
  const baseCollection = db.collection(spec.collection);
  if (!baseCollection) {
    return [];
  }

  const baseOptions = {};
  if (spec.joins.length === 0 && spec.projection) {
    baseOptions.projection = spec.projection;
  }

  const baseDocs = await baseCollection.find(spec.filter || {}, baseOptions);
  let contexts = baseDocs.map((doc) => ({
    aliases: new Map([[spec.baseAlias, doc]]),
  }));

  for (const join of spec.joins) {
    const joinCollection = db.collection(join.collection);
    if (!joinCollection) {
      return [];
    }

    const nextContexts = [];
    for (const context of contexts) {
      const leftField = join.condition.left.alias + '.' + join.condition.left.path;
      const leftValue = resolveFieldFromContext(context, leftField, spec.baseAlias);
      if (leftValue === undefined) {
        continue;
      }

      const filter = {};
      setByPath(filter, join.condition.right.path, leftValue);
      const matches = await joinCollection.find(filter, { projection: null });

      for (const match of matches) {
        const aliases = new Map(context.aliases);
        aliases.set(join.alias, match);
        nextContexts.push({ aliases });
      }
    }

    contexts = nextContexts;
    if (contexts.length === 0) {
      break;
    }
  }

  return contexts;
};

const executeSqlSpec = async (db, spec) => {
  if (spec.having && !spec.isAggregate && spec.groupBy.length === 0) {
    throw new Error('HAVING clause requires aggregate expressions or GROUP BY');
  }

  const contexts = await buildContexts(db, spec);
  if (contexts.length === 0) {
    return [];
  }

  if (!spec.isAggregate) {
    let rows;
    if (spec.hasWildcard) {
      rows = contexts.map((context) => cloneDeep(context.aliases.get(spec.baseAlias)));
    } else {
      rows = applyFieldSelection(
        contexts,
        spec.selectExpressions.filter((expr) => expr.type === 'field'),
        spec.baseAlias,
      );
    }
    rows = sortResults(rows, spec.orderBy);
    if (spec.limit !== null) {
      rows = rows.slice(0, spec.limit);
    }
    return rows;
  }

  let rows = aggregateDocuments(contexts, spec);

  if (spec.having) {
    rows = rows.filter((row) => matchFilter(row, spec.having));
  }

  rows = sortResults(rows, spec.orderBy);

  if (spec.limit !== null) {
    rows = rows.slice(0, spec.limit);
  }

  return rows;
};

const runSql = async (db, input, ...values) => {
  const { sql, params } = normalizeSqlInput(input, values);
  const trimmed = sql.trim();

  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("$")) {
    const compiled = db.compile(trimmed);
    const results = [];
    for await (const doc of db.stream(compiled)) {
      results.push(doc);
    }
    return results;
  }

  const spec = parseSqlStatement(trimmed, params);
  return executeSqlSpec(db, spec);
};

module.exports = {
  runSql,
  _internal: {
    normalizeSqlInput,
    parseSqlStatement,
    parseWhere,
    tokenize,
  },
};
