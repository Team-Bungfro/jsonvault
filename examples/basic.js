"use strict";

const path = require("path");
const { JsonDatabase, createSchema, Sort } = require("../src");

const userSchema = createSchema({
  fields: {
    name: { type: "string", required: true, trim: true, minLength: 3 },
  },
  allowAdditional: false,
});

const tasksHook = {
  beforeInsert(doc) {
    doc.createdAt = new Date().toISOString();
  },
  afterUpdate({ previous, next }) {
    if (previous.done !== next.done && next.done) {
      console.log(`Task ${next._id} completed`);
    }
  },
};

const taskSchema = createSchema({
  fields: {
    title: { type: "string", required: true, trim: true, minLength: 3 },
    done: { type: "boolean", default: false },
    due: { type: "date", allowNull: true },
    assigneeId: { type: "string", required: true },
    createdAt: { type: "date", default: () => new Date().toISOString() },
  },
  allowAdditional: false,
});

const run = async () => {
  const dataDir = path.resolve(__dirname, "../.examples/data");
  const db = await JsonDatabase.open({
    path: dataDir,
    changeLog: {
      path: path.join(dataDir, "tasks.changelog.jsonl"),
    },
  });

  if (db.changeLog) {
    await db.changeLog.clear();
  }

  const users = db.collection("users", { schema: userSchema });
  const tasks = db.collection("tasks", {
    schema: taskSchema,
    hooks: tasksHook,
  });

  // Reset sample data so the example is idempotent.
  await users.deleteMany({});
  await tasks.deleteMany({});

  const [ada, grace] = await users.insertMany([
    { name: "Ada Lovelace" },
    { name: "Grace Hopper" },
  ]);

  await tasks.insertMany([
    { title: "Prototype demo", assigneeId: ada._id },
    { title: "Write docs", assigneeId: grace._id },
  ]);

  const now = new Date();
  const updatePlan = [
    { filter: { title: "Prototype demo" }, dueInDays: 2 },
    { filter: { title: "Write docs" }, dueInDays: 5 },
  ];

  for (const entry of updatePlan) {
    const due = new Date(now.getTime() + entry.dueInDays * 24 * 3600 * 1000);
    await tasks.updateMany(entry.filter, { $set: { due: due.toISOString() } });
  }

  // Mark one task complete so the hook logs a message.
  await tasks.updateOne({ title: "Prototype demo" }, { $set: { done: true } });

  const upcoming = await tasks.find(
    { done: false },
    { sort: { due: Sort.ASC } }
  );
  console.log("Upcoming tasks:", upcoming);

  const statusCounts = await tasks.countBy("done");
  console.log("Task counts:", statusCounts);

  const assignments = await db.sql`
      SELECT users.name AS assignee, COUNT(tasks._id) AS openTasks
      FROM tasks
      JOIN users ON tasks.assigneeId = users._id
      WHERE done = false
      GROUP BY users.name
      ORDER BY openTasks DESC
    `;
  console.log("Open tasks by assignee:", assignments);

  const changes = await db.changeLog.read({ from: 1 });
  console.log("Recent change log entries:", changes.slice(-5));

  await db.save();
  await db.close();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
