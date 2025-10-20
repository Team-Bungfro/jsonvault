---
sidebar_position: 3
title: SQL helper guide
---

JSONVault ships with a SQL helper so you can write expressive queries without leaving JavaScript. It compiles a subset of SQL into the same query engine that powers filter objects.

## When to use SQL

- Aggregations (`SUM`, `COUNT`, `AVG`, `MIN`, `MAX`)
- `GROUP BY` / `HAVING`
- Simple joins (`JOIN users ON orders.userId = users._id`)
- Ad-hoc analytics or reporting (especially when piping results into CSV/CLI)
- Targeted inserts/updates when you want quick admin helpers without switching APIs

For simple CRUD screens, stick to the collection helpers (`find`, `updateMany`, etc.).

## Basics

```js
const results = await db.sql`
  SELECT userId, SUM(total) AS spend
  FROM orders
  WHERE status = 'paid'
  GROUP BY userId
  HAVING spend > 1000
  ORDER BY spend DESC
  LIMIT 25
`;
```

Template parameters (`${value}`) prevent injection attacks and handle Date/number/string coercion automatically.

## Write operations

### Insert documents

```js
const insertResult = await db.sql`
  INSERT INTO users (name, email, active)
  VALUES (${"Ada"}, ${"ada@example.com"}, TRUE),
         (${"Grace"}, ${"grace@example.com"}, FALSE)
`;

console.log(insertResult.insertedCount); // 2
console.log(insertResult.insertedIds);   // ["..."]
```

- Provide a column list, or pass a single object: `INSERT INTO users VALUES (${doc})`.
- Nested paths use dot notation (`profile.lastSeen`).
- The result object includes `operation`, `insertedCount`, `insertedIds`, and the inserted documents.

### Update documents

```js
const updateResult = await db.sql`
  UPDATE users
  SET status = 'active', metrics.lastSeen = ${new Date()}
  WHERE email = ${"ada@example.com"}
`;

console.log(updateResult.modifiedCount); // 1
```

- `SET` uses `$set` semantics under the hood; combine with dot notation for nested paths.
- `WHERE` is optional but recommended — omit it only when you intend to update every document.
- Result metadata exposes `matchedCount`, `modifiedCount`, and `upsertedId` (when applicable).

### Batch scripts

Execute multiple statements atomically with `db.sqlBatch\`\`` — results are returned in order:

```js
const batchResults = await db.sqlBatch`
  INSERT INTO users (name, email) VALUES (${"Ada"}, ${"ada@example.com"});
  UPDATE users SET active = TRUE WHERE email = ${"ada@example.com"};
  SELECT email, active FROM users WHERE email = ${"ada@example.com"};
`;

console.log(batchResults.length); // 3
console.log(batchResults[0].operation); // "insert"
console.log(batchResults[2]); // [{ email: "ada@example.com", active: true }]
```

If any statement throws, the entire batch is rolled back.

## Joins

```js
const ordersWithEmail = await db.sql`
  SELECT orders.id AS orderId,
         orders.total,
         users.email
  FROM orders
  JOIN users ON orders.userId = users._id
  WHERE orders.total > 500
  ORDER BY orderId
`;
```

Current limitations:

- Single inner join per query.
- Join condition must be equality.
- `SELECT *` is allowed when no join is present.
- `INSERT` supports `VALUES` tuples (column list or single object), `UPDATE` maps to `$set` updates, and `DELETE` accepts predicates.

On the roadmap: multi-join support, outer joins, richer OR conditions, and view definitions.

## JSONPath passthrough

If you prefer JSONPath syntax, pass a string directly:

```js
const bigOrders = await db.sql("$.orders[?(@.total > 1000)]");
```

## Error handling

Invalid syntax throws a regular `Error` with a descriptive message (`Unsupported expression...`, `Statement must start with SELECT, INSERT, UPDATE, or DELETE`, etc.). Wrap SQL calls in `try/catch` if you accept user input.

## CLI integration

```bash
npx jsonvault query ./data "SELECT COUNT(*) AS total FROM orders"
```

The CLI writes JSON to stdout, perfect for piping into `jq` or feeding shell scripts.
