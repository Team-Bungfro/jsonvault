---
sidebar_position: 2
title: Schema guide
---

Schemas let you define expected structure, defaults, transforms, and validation logic for your documents. They sit in front of hooks and validators, so you can rely on the document shape by the time hooks run.

## Creating a schema

```js
const { createSchema } = require("jsonvault");

const userSchema = createSchema({
  fields: {
    name: { type: "string", required: true, minLength: 2, trim: true },
    email: {
      type: "string",
      required: true,
      pattern: ".+@.+\\..+",
      transform: (value) => value.toLowerCase(),
    },
    age: { type: "number", min: 0, default: 0 },
    roles: { type: "array", items: "string", default: () => [] },
    profile: {
      type: "object",
      fields: {
        theme: { type: "string", enum: ["light", "dark"], default: "light" },
      },
      allowAdditional: false,
    },
  },
  allowAdditional: false,
});
```

Attach the schema when you open a collection:

```js
const users = db.collection("users", { schema: userSchema });
```

## Field properties

| Property | Description |
| -------- | ----------- |
| `type` | `"string"`, `"number"`, `"boolean"`, `"date"`, `"array"`, `"object"`, `"any"` |
| `required` | Rejects documents missing the field |
| `default` | Value or function applied when field missing |
| `min`, `max` | Bounds for numbers/dates |
| `minLength`, `maxLength` | Bounds for strings/arrays |
| `pattern` | RegEx (string or RegExp) matched against string values |
| `enum` | Whitelist of acceptable values |
| `transform` | `(value, context) => newValue` run before validation completes |
| `validate` | `(value, context) => { throw new Error(...) }` for custom checks |

### Array fields

Set `items` to a type or nested schema definition:

```js
roles: { type: "array", items: "string" }
```

### Object fields

Embed deeper object definitions using `fields`. Use `allowAdditional` to control whether unknown keys are allowed.

## Context object

`transform` and `validate` receive `{ document, path, operation, collection }` so you can tailor logic to inserts vs. updates or inspect sibling fields.

## Error handling

Schema validation throws when a rule fails. Catch these errors in your application layer to return clear responses:

```js
try {
  await users.insertOne(payload);
} catch (error) {
  if (error.name === "JsonVaultSchemaError") {
    reply.status(400).send({ message: error.message });
  }
}
```

## Tips

- Start with `allowAdditional: false` to catch typos early; relax it later if you introduce unstructured metadata.
- Use schema `transform` to normalise values (e.g. lowercase emails) before hooks or validators run.
- For complex logic, prefer schema `validate` or collection validators over hooks; they integrate better with migrations and bulk operations.
