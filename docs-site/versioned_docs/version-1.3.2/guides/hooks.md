---
sidebar_position: 1
title: Hooks
---

Hooks let you run custom code around collection lifecycle events. They are ideal for enforcing invariants, populating derived fields, or triggering side-effects (metrics, queues, audit logs).

## Supported hooks

| Hook | Signature | Runs when |
| ---- | --------- | -------- |
| `beforeInsert(doc)` | Mutable document | After schema validation, before persistence |
| `afterInsert(doc)` | Immutable snapshot | After the document is stored |
| `beforeUpdate({ previous, next, update })` | Mutable `next` | Before indexes update |
| `afterUpdate({ previous, next })` | Immutable snapshots | After the document is stored |
| `beforeDelete(doc)` | Immutable snapshot | Before the document is removed |
| `afterDelete(doc)` | Immutable snapshot | After removal |

Hooks can be async and throw errors to abort the operation.

## Example

```js
const users = db.collection("users", {
  hooks: {
    beforeInsert(doc) {
      doc.slug = doc.name.toLowerCase().replace(/\s+/g, "-");
      doc.createdAt = new Date().toISOString();
    },
    afterInsert(doc) {
      metrics.increment("users.created");
      audit.log({ action: "create", collection: "users", id: doc._id });
    },
    beforeDelete(doc) {
      if (doc.role === "owner") {
        throw new Error("Cannot delete owners");
      }
    },
  },
});
```

### Composition

Calling `db.collection("users", { hooks })` multiple times merges the handlers. This makes it easy to split hooks across modules (e.g. auditing vs. validation).

### Tips

- Keep hooks fast—heavy work should move to background jobs.
- Always defensively clone external inputs (e.g. network payloads) before mutating them.
- When combining with schemas, remember: schema → validator → `beforeInsert`/`beforeUpdate`.
