"use strict";

const { cloneDeep, getByPath, setByPath } = require("../utils/objectUtils");
const { compareValues, matchFilter } = require("../query/operators");
const {
  QueryError,
  InvalidArgumentError,
} = require("../errors");

const PARAM_MARKER = "__jsonvault_param_";

const KEYWORDS = new Set(["AND", "OR", "BETWEEN", "IN", "IS", "NOT", "NULL", "LIKE"]);

const TRUTHY_KEYWORDS = new Map([
  ["TRUE", true],
  ["FALSE", false],
]);

const wrapMarker = Symbol("jsonvaultSqlError");
const SNIPPET_LENGTH = 80;

const formatSnippet = (text = "") => {
  const trimmed = text.trim();
  if (trimmed.length <= SNIPPET_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, SNIPPET_LENGTH - 3)}...`;
};

const wrapSqlError = (error, clause, text) => {
  if (!error) {
    return error;
  }

  if (error[wrapMarker]) {
    return error;
  }

  const snippet = formatSnippet(text);
  const clauseLabel = clause ? `${clause} clause` : "SQL";
  const suffix = snippet ? ` near "${snippet}"` : "";
  const wrapped = new QueryError(`${error.message} (${clauseLabel}${suffix})`, {
    clause: clauseLabel,
    snippet,
    cause: error,
  });
  wrapped[wrapMarker] = true;
  return wrapped;
};

const withClause = (clause, text, fn) => {
  try {
    return fn();
  } catch (error) {
    throw wrapSqlError(error, clause, text);
  }
};

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

const JOIN_PATTERNS = [
  { regex: /^LEFT\s+OUTER\s+JOIN\s+/i, type: "left" },
  { regex: /^LEFT\s+JOIN\s+/i, type: "left" },
  { regex: /^INNER\s+JOIN\s+/i, type: "inner" },
  { regex: /^JOIN\s+/i, type: "inner" },
];

const CLAUSE_KEYWORDS = ["WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT"];

const isWhitespace = (char) => {
  if (!char) {
    return true;
  }
  return /\s/.test(char);
};

const findMatchingParen = (input, startIndex = 0) => {
  let depth = 0;
  let quote = null;
  for (let i = startIndex; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
};

const findNextJoin = (input, startIndex = 0) => {
  const upper = input.toUpperCase();
  let depth = 0;
  let quote = null;

  for (let i = startIndex; i < upper.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0) {
      for (const pattern of JOIN_PATTERNS) {
        if (upper.slice(i).match(pattern.regex)) {
          return { index: i, pattern };
        }
      }
    }
  }

  return null;
};

const splitFromSegments = (input) => {
  const segments = [];
  let start = 0;
  while (start < input.length) {
    const match = findNextJoin(input, start);
    if (!match) {
      const tail = input.slice(start).trim();
      if (tail) {
        segments.push(tail);
      }
      break;
    }

    const before = input.slice(start, match.index).trim();
    if (before) {
      segments.push(before);
    }

    // find the next join to slice this segment
    const next = findNextJoin(input, match.index + input.slice(match.index).match(match.pattern.regex)[0].length);
    if (!next) {
      const tail = input.slice(match.index).trim();
      if (tail) {
        segments.push(tail);
      }
      break;
    }

    const between = input.slice(match.index, next.index).trim();
    if (between) {
      segments.push(between);
    }
    start = next.index;
  }

  if (segments.length === 0 && input.trim()) {
    segments.push(input.trim());
  }

  return segments;
};

const splitOnKeywordOutsideParens = (input, keyword) => {
  const upper = input.toUpperCase();
  const target = keyword.toUpperCase();
  let depth = 0;
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && upper.slice(i, i + target.length) === target) {
      return {
        left: input.slice(0, i).trim(),
        right: input.slice(i + target.length).trim(),
      };
    }
  }

  return null;
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

const findNextClauseIndex = (input, startIndex, keywords) => {
  const upper = input.toUpperCase();
  let depth = 0;
  let quote = null;

  for (let i = startIndex; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    for (const keyword of keywords) {
      if (upper.startsWith(keyword, i)) {
        const before = i === 0 ? " " : input[i - 1];
        const after = input[i + keyword.length] || " ";
        if (isWhitespace(before) && isWhitespace(after)) {
          return i;
        }
      }
    }
  }

  return input.length;
};

const parseTableReference = (input, params) => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new QueryError("Table reference cannot be empty");
  }

  if (trimmed.startsWith("(")) {
    const closing = findMatchingParen(trimmed, 0);
    if (closing === -1) {
      throw new QueryError("Subquery is missing closing parenthesis");
    }
    const inner = trimmed.slice(1, closing);
    const remainder = trimmed.slice(closing + 1).trim();
    if (!remainder) {
      throw new QueryError("Subquery in FROM clause requires an alias");
    }
    let aliasPart = remainder;
    if (/^AS\s+/i.test(aliasPart)) {
      aliasPart = aliasPart.replace(/^AS\s+/i, "");
    }
    const aliasTokens = aliasPart.split(/\s+/);
    const alias = aliasTokens[0];
    if (!alias) {
      throw new QueryError("Subquery in FROM clause requires an alias");
    }
    const subquerySpec = parseSqlStatement(inner, params);
    return {
      type: "subquery",
      alias,
      subquery: subquerySpec,
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 0) {
    throw new QueryError("Table reference cannot be empty");
  }
  const collection = parts[0];
  let alias = collection;
  if (parts.length >= 2) {
    if (parts[1].toUpperCase() === "AS") {
      alias = parts[2];
      if (!alias) {
        throw new QueryError(`Alias expected after AS for table "${collection}"`);
      }
    } else {
      alias = parts[1];
    }
  }

  return {
    type: "collection",
    collection,
    alias,
  };
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
    throw new QueryError("Expected value in WHERE clause");
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

  throw new QueryError("Unsupported value in WHERE clause");
};

const parseBetween = (field, tokens, index, params) => {
  const start = readValueToken(tokens, index, params);
  const afterStart = tokens[start.index];

  if (!afterStart || afterStart.type !== "keyword" || afterStart.value !== "AND") {
    throw new QueryError("BETWEEN requires 'AND'");
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
      throw new QueryError("Unexpected end of IN list");
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
  throw new QueryError("IN list missing closing parenthesis");
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
      throw new QueryError(`Unsupported operator '${operator}'`);
  }

  return {
    clause,
    nextIndex: valueToken.index,
  };
};

const parseConditionTokens = (tokens, startIndex, params) => {
  const fieldToken = tokens[startIndex];
  if (!fieldToken || fieldToken.type !== "identifier") {
    throw new QueryError("Expected field name in WHERE clause");
  }
  const field = fieldToken.value;
  let index = startIndex + 1;
  const token = tokens[index];

  if (!token) {
    throw new QueryError("Unexpected end of WHERE clause");
  }

  if (token.type === "keyword" && token.value === "BETWEEN") {
    const between = parseBetween(field, tokens, index + 1, params);
    return { clause: between.clause, nextIndex: between.nextIndex };
  }

  if (token.type === "keyword" && token.value === "IN") {
    const afterIn = tokens[index + 1];
    if (!afterIn || afterIn.type !== "(") {
      throw new QueryError("IN clause must start with '('");
    }
    const parsed = parseInList(field, tokens, index + 2, params);
    return { clause: parsed.clause, nextIndex: parsed.nextIndex };
  }

  if (token.type === "operator") {
    return parseComparison(field, token.value, tokens, index + 1, params);
  }

  throw new QueryError(`Unsupported WHERE condition near '${field}'`);
};

const parseWhere = (input, params) => {
  if (!input) {
    return null;
  }

  try {
    const tokens = tokenize(input);
    if (tokens.length === 0) {
      return null;
    }

    const parsed = parseOrConditions(tokens, 0, params);
    if (parsed.nextIndex < tokens.length) {
      const remaining = tokens.slice(parsed.nextIndex).map((token) => token.value || token.type);
      throw new QueryError(`Unexpected tokens ${remaining.join(" ")}`);
    }
    return parsed.clause;
  } catch (error) {
    throw wrapSqlError(error, "WHERE", input);
  }
};

function parseConditionGroup(tokens, index, params) {
  const token = tokens[index];
  if (!token) {
    throw new QueryError("Unexpected end of WHERE clause");
  }

  if (token.type === "(") {
    const inner = parseOrConditions(tokens, index + 1, params);
    const closing = tokens[inner.nextIndex];
    if (!closing || closing.type !== ")") {
      throw new QueryError("Missing closing parenthesis in WHERE clause");
    }
    return {
      clause: inner.clause,
      nextIndex: inner.nextIndex + 1,
    };
  }

  return parseConditionTokens(tokens, index, params);
}

function parseAndConditions(tokens, index, params) {
  const clauses = [];
  let cursor = index;

  while (cursor < tokens.length) {
    const result = parseConditionGroup(tokens, cursor, params);
    clauses.push(result.clause);
    cursor = result.nextIndex;

    const separator = tokens[cursor];
    if (!separator || separator.type !== "keyword" || separator.value !== "AND") {
      break;
    }
    cursor += 1;
  }

  if (clauses.length === 1) {
    return { clause: clauses[0], nextIndex: cursor };
  }
  return { clause: { $and: clauses }, nextIndex: cursor };
}

function parseOrConditions(tokens, index, params) {
  const clauses = [];
  let cursor = index;

  while (cursor < tokens.length) {
    const result = parseAndConditions(tokens, cursor, params);
    clauses.push(result.clause);
    cursor = result.nextIndex;

    const separator = tokens[cursor];
    if (!separator || separator.type !== "keyword" || separator.value !== "OR") {
      break;
    }
    cursor += 1;
  }

  if (clauses.length === 1) {
    return { clause: clauses[0], nextIndex: cursor };
  }

  return { clause: { $or: clauses }, nextIndex: cursor };
}

const parseQualifiedField = (input) => {
  const trimmed = input.trim();
  const parts = trimmed.split(".");
  if (parts.length < 2) {
    throw new QueryError(`Expected qualified field (alias.field) but received "${input}"`);
  }
  const [alias, ...pathParts] = parts;
  return { alias, path: pathParts.join(".") };
};
const parseJoinSegment = (segment, params) => {
  let working = segment.trim();
  if (!working) {
    throw new QueryError("JOIN clause cannot be empty");
  }

  let joinType = "inner";
  let matched = null;
  for (const pattern of JOIN_PATTERNS) {
    const match = working.match(pattern.regex);
    if (match) {
      joinType = pattern.type;
      matched = match[0];
      working = working.slice(match[0].length).trim();
      break;
    }
  }

  if (!matched) {
    throw new QueryError("JOIN clause must specify JOIN keyword");
  }

  const onSplit = splitOnKeywordOutsideParens(working, "ON");
  if (!onSplit) {
    throw new QueryError("JOIN clause must include ON <left> = <right>");
  }

  const target = parseTableReference(onSplit.left, params);
  const condition = onSplit.right;
  const comparison = /^([A-Za-z0-9_.]+)\s*=\s*([A-Za-z0-9_.]+)$/i.exec(condition);
  if (!comparison) {
    throw new QueryError("Only equality JOIN conditions are supported");
  }

  const left = parseQualifiedField(comparison[1]);
  const right = parseQualifiedField(comparison[2]);

  return {
    type: joinType,
    target,
    alias: target.alias,
    condition: {
      left,
      right,
    },
  };
};

const parseFromClause = (input, params) => {
  const segments = splitFromSegments(input);
  if (segments.length === 0) {
    throw new QueryError("FROM clause cannot be empty");
  }

  const base = parseTableReference(segments[0], params);
  const joins = [];

  for (let i = 1; i < segments.length; i += 1) {
    joins.push(parseJoinSegment(segments[i], params));
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

  const windowCountMatch = raw.match(/^COUNT\s*\(\s*\*\s*\)\s+OVER\s*\(\s*\)\s*$/i);
  if (windowCountMatch) {
    return {
      type: "window_count",
      alias: alias || "count_over_all",
    };
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

  const aliasWildcardMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\.\*$/);
  if (aliasWildcardMatch) {
    const target = aliasWildcardMatch[1];
    return {
      type: "aliasWildcard",
      target,
      alias: alias || target,
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
    throw new InvalidArgumentError("db.sql requires a template string or raw SQL string");
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

const parseSqlStatement = (sql, params) => {
  const trimmed = sql.trim().replace(/;$/, "");
  const upper = trimmed.toUpperCase();

  if (!upper.startsWith("SELECT ")) {
    throw new QueryError("Only SELECT statements are supported");
  }

  const fromRegex = /\sFROM\s|\sFROM\(/i;
  const fromMatch = fromRegex.exec(upper);
  if (!fromMatch) {
    throw new QueryError("SELECT statement must include FROM clause");
  }
  const fromIndex = fromMatch.index;
  const fromToken = fromMatch[0];

  const selectPart = trimmed.slice("SELECT ".length, fromIndex).trim();
  let cursor = fromIndex + fromToken.length;
  if (fromToken.endsWith("(")) {
    cursor -= 1;
  }

  const nextClauseIndex = findNextClauseIndex(trimmed, cursor, CLAUSE_KEYWORDS);
  const fromPart = trimmed.slice(cursor, nextClauseIndex).trim();
  if (!fromPart) {
    throw new QueryError("FROM clause must specify a collection");
  }

  cursor = nextClauseIndex;

  let wherePart = null;
  let groupPart = null;
  let havingPart = null;
  let orderPart = null;
  let limitPart = null;

  while (cursor < trimmed.length) {
    if (upper.startsWith("WHERE", cursor)) {
      let start = cursor + "WHERE".length;
      while (start < trimmed.length && /\s/.test(trimmed[start])) start += 1;
      const end = findNextClauseIndex(trimmed, start, CLAUSE_KEYWORDS);
      wherePart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (upper.startsWith("GROUP BY", cursor)) {
      let start = cursor + "GROUP BY".length;
      while (start < trimmed.length && /\s/.test(trimmed[start])) start += 1;
      const end = findNextClauseIndex(trimmed, start, CLAUSE_KEYWORDS);
      groupPart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (upper.startsWith("HAVING", cursor)) {
      let start = cursor + "HAVING".length;
      while (start < trimmed.length && /\s/.test(trimmed[start])) start += 1;
      const end = findNextClauseIndex(trimmed, start, CLAUSE_KEYWORDS);
      havingPart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (upper.startsWith("ORDER BY", cursor)) {
      let start = cursor + "ORDER BY".length;
      while (start < trimmed.length && /\s/.test(trimmed[start])) start += 1;
      const end = findNextClauseIndex(trimmed, start, CLAUSE_KEYWORDS);
      orderPart = trimmed.slice(start, end).trim();
      cursor = end;
      continue;
    }
    if (upper.startsWith("LIMIT", cursor)) {
      let start = cursor + "LIMIT".length;
      while (start < trimmed.length && /\s/.test(trimmed[start])) start += 1;
      limitPart = trimmed.slice(start).trim();
      cursor = trimmed.length;
      continue;
    }
    break;
  }

  const selectExpressions = splitOnComma(selectPart).map((expression) =>
    withClause("SELECT", expression, () => parseSelectExpression(expression)),
  );
  const windowFunctions = selectExpressions.filter((expr) => expr.type === "window_count");
  const fromSpec = withClause("FROM", fromPart, () => parseFromClause(fromPart, params));
  const hasWildcard = selectExpressions.some((expr) => expr.type === "wildcard");
  const aliasWildcards = selectExpressions.filter((expr) => expr.type === "aliasWildcard");
  const hasAliasWildcard = aliasWildcards.length > 0;
  const aggregates = selectExpressions.filter((expr) => expr.type === "aggregate");
  const isAggregate = aggregates.length > 0;

  if (hasWildcard && isAggregate) {
    throw new QueryError("Cannot mix '*' with aggregate expressions");
  }

  const fields = selectExpressions.filter((expr) => expr.type === "field");

  if (isAggregate && hasAliasWildcard) {
    throw wrapSqlError(
      new Error("Alias wildcards are not supported in aggregate queries"),
      "SELECT",
      selectPart,
    );
  }
  let projection = null;
  if (
    !isAggregate &&
    fromSpec.base.type === "collection" &&
    fromSpec.joins.length === 0 &&
    fields.length > 0
  ) {
    projection = {};
    fields.forEach((expr) => {
      if (!expr.field.includes(".")) {
        projection[expr.field] = 1;
      }
    });
  }

  if (fromSpec.joins.length > 0 && hasWildcard) {
    throw new QueryError("SELECT * is not supported with JOIN queries");
  }

  const aliasLookup = new Map();
  aliasLookup.set(fromSpec.base.alias, fromSpec.base.alias);
  if (fromSpec.base.type === "collection") {
    aliasLookup.set(fromSpec.base.collection, fromSpec.base.alias);
  }
  for (const join of fromSpec.joins) {
    aliasLookup.set(join.alias, join.alias);
    if (join.target.type === "collection") {
      aliasLookup.set(join.target.collection, join.alias);
    }
  }

  for (const expr of aliasWildcards) {
    if (!aliasLookup.has(expr.target)) {
      throw wrapSqlError(
        new Error(`Unknown alias "${expr.target}" in SELECT expressions`),
        "SELECT",
        selectPart,
      );
    }
    expr.target = aliasLookup.get(expr.target);
  }

  const filter = wherePart ? withClause("WHERE", wherePart, () => parseWhere(wherePart, params)) : null;
  const having = havingPart ? withClause("HAVING", havingPart, () => parseWhere(havingPart, params)) : null;
  const groupBy = groupPart ? splitOnComma(groupPart).map((entry) => entry.trim()).filter(Boolean) : [];
  const orderBy = parseOrderBy(orderPart);
  let limit = null;
  let offset = 0;
  if (limitPart) {
    const limitMatch = limitPart.match(/^([0-9]+)(?:\s+OFFSET\s+([0-9]+))?$/i);
    if (!limitMatch) {
      throw new QueryError("LIMIT clause must be of the form 'LIMIT <n>' or 'LIMIT <n> OFFSET <m>'");
    }
    limit = Number(limitMatch[1]);
    if (!Number.isFinite(limit) || limit < 0) {
      throw new QueryError("LIMIT must be a non-negative number");
    }
    if (limitMatch[2] !== undefined) {
      offset = Number(limitMatch[2]);
      if (!Number.isFinite(offset) || offset < 0) {
        throw new QueryError("OFFSET must be a non-negative number");
      }
    }
  }

  return {
    base: fromSpec.base,
    baseAlias: fromSpec.base.alias,
    joins: fromSpec.joins,
    selectExpressions,
    windowFunctions,
    hasWildcard,
    hasAliasWildcard,
    isAggregate,
    projection,
    filter,
    having,
    groupBy,
    orderBy,
    limit,
    offset,
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

const applyFieldSelection = (contexts, spec) =>
  contexts.map((context) => {
    const baseDoc = context.aliases.get(spec.baseAlias);
    const row =
      spec.hasWildcard && baseDoc && typeof baseDoc === "object"
        ? cloneDeep(baseDoc)
        : {};

    for (const expr of spec.selectExpressions) {
      if (expr.type === "wildcard" || expr.type === "aggregate" || expr.type === "window_count") {
        continue;
      }

      if (expr.type === "aliasWildcard") {
        const sourceDoc = context.aliases.get(expr.target);
        const value = sourceDoc === undefined ? null : cloneDeep(sourceDoc);
        setByPath(row, expr.alias, value);
        continue;
      }

      if (expr.type === "field") {
        const value = resolveFieldFromContext(context, expr.field, spec.baseAlias);
        setByPath(row, expr.alias, value);
      }
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

const applyWindowFunctions = (rows, windowFunctions) => {
  if (!windowFunctions || windowFunctions.length === 0) {
    return rows;
  }

  const totalCount = rows.length;
  return rows.map((row) => {
    const output = row;
    for (const fn of windowFunctions) {
      if (fn.type === "window_count") {
        setByPath(output, fn.alias, totalCount);
      }
    }
    return output;
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
            throw new QueryError(`Unsupported aggregate function '${expr.func}'`);
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
  let baseRows = [];

  if (spec.base.type === "collection") {
    const baseCollection = db.collection(spec.base.collection);
    if (!baseCollection) {
      return [];
    }
    const baseOptions = {};
    if (spec.joins.length === 0 && spec.projection) {
      baseOptions.projection = spec.projection;
    }
    baseRows = await baseCollection.find(spec.filter || {}, baseOptions);
  } else {
    baseRows = await executeSqlSpec(db, spec.base.subquery);
  }

  let contexts = baseRows.map((row) => ({
    aliases: new Map([[spec.baseAlias, row]]),
  }));

  const subqueryCache = new Map();

  for (const join of spec.joins) {
    let joinCollection = null;
    if (join.target.type === "collection") {
      joinCollection = db.collection(join.target.collection);
      if (!joinCollection) {
        if (join.type === "left") {
          contexts = contexts.map((context) => {
            const aliases = new Map(context.aliases);
            aliases.set(join.alias, null);
            return { aliases };
          });
          continue;
        }
        return [];
      }
    }

    const nextContexts = [];
    if (contexts.length === 0) {
      break;
    }

    for (const context of contexts) {
      const leftUsesTarget = join.condition.left.alias === join.alias;
      const rightUsesTarget = join.condition.right.alias === join.alias;

      if (leftUsesTarget && rightUsesTarget) {
        throw new QueryError("JOIN condition must reference the joined table and an existing table");
      }

      const sourceCondition = leftUsesTarget ? join.condition.right : join.condition.left;
      const targetPath = leftUsesTarget ? join.condition.left.path : join.condition.right.path;
      const sourceField = `${sourceCondition.alias}.${sourceCondition.path}`;
      const sourceValue = resolveFieldFromContext(context, sourceField, spec.baseAlias);

      if (join.target.type === "collection") {
        if (sourceValue === undefined) {
          if (join.type === "left") {
            const aliases = new Map(context.aliases);
            aliases.set(join.alias, null);
            nextContexts.push({ aliases });
          }
          continue;
        }

        const filter = {};
        setByPath(filter, targetPath, sourceValue);
        const matches = await joinCollection.find(filter, { projection: null });

        if (matches.length === 0) {
          if (join.type === "left") {
            const aliases = new Map(context.aliases);
            aliases.set(join.alias, null);
            nextContexts.push({ aliases });
          }
          continue;
        }

        for (const match of matches) {
          const aliases = new Map(context.aliases);
          aliases.set(join.alias, match);
          nextContexts.push({ aliases });
        }
        continue;
      }

      if (!subqueryCache.has(join.alias)) {
        const rows = await executeSqlSpec(db, join.target.subquery);
        subqueryCache.set(join.alias, rows);
      }
      const dataset = subqueryCache.get(join.alias);

      const matches = dataset.filter((row) => {
        const candidate = getByPath(row, targetPath);
        return compareValues(candidate, sourceValue) === 0;
      });

      if (matches.length === 0) {
        if (join.type === "left") {
          const aliases = new Map(context.aliases);
          aliases.set(join.alias, null);
          nextContexts.push({ aliases });
        }
        continue;
      }

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

  if (!spec.filter || (spec.base.type === "collection" && spec.joins.length === 0)) {
    return contexts;
  }

  const filtered = contexts.filter((context) => {
    const combined = {};
    for (const [alias, doc] of context.aliases.entries()) {
      combined[alias] = doc;
      if (alias === spec.baseAlias && doc && typeof doc === "object") {
        Object.assign(combined, doc);
      }
    }
    return matchFilter(combined, spec.filter);
  });

  return filtered;
};

const executeSqlSpec = async (db, spec) => {
  if (spec.having && !spec.isAggregate && spec.groupBy.length === 0) {
    throw new QueryError('HAVING clause requires aggregate expressions or GROUP BY');
  }

  const contexts = await buildContexts(db, spec);
  if (contexts.length === 0) {
    return [];
  }

  if (!spec.isAggregate) {
    let rows = applyFieldSelection(contexts, spec);
    rows = sortResults(rows, spec.orderBy);
    rows = applyWindowFunctions(rows, spec.windowFunctions);
    if (spec.offset) {
      rows = rows.slice(spec.offset);
    }
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
  rows = applyWindowFunctions(rows, spec.windowFunctions);

  if (spec.offset) {
    rows = rows.slice(spec.offset);
  }

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

  let spec;
  try {
    spec = parseSqlStatement(trimmed, params);
  } catch (error) {
    throw wrapSqlError(error, null, trimmed);
  }
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
