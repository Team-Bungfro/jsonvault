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

Future enhancements on the roadmap: multi-join support, outer joins, and OR conditions.

## JSONPath passthrough

If you prefer JSONPath syntax, pass a string directly:

```js
const bigOrders = await db.sql("$.orders[?(@.total > 1000)]");
```

## Error handling

Invalid syntax throws a regular `Error` with a descriptive message (`Unsupported expression...`, `Only SELECT statements are supported`, etc.). Wrap SQL calls in `try/catch` if you accept user input.

## CLI integration

```bash
npx jsonvault query ./data "SELECT COUNT(*) AS total FROM orders"
```

The CLI writes JSON to stdout, perfect for piping into `jq` or feeding shell scripts.
