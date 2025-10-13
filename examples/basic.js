"use strict";

const path = require("path");
const { JsonDatabase, createSchema } = require("../src");

const taskSchema = createSchema({
  fields: {
    title: { type: "string", required: true, trim: true, minLength: 3 },
    done: { type: "boolean", default: false },
    due: { type: "date", allowNull: true },
  },
  allowAdditional: false,
});

const run = async () => {
  const db = await JsonDatabase.open({
    path: path.resolve(__dirname, "../.examples/data"),
  });

  const tasks = db.collection("tasks", {
    schema: taskSchema,
  });

  await tasks.insertOne({ title: "Prototype demo", done: false });
  await tasks.insertOne({ title: "Write docs", done: false });

  await tasks.updateMany(
    { done: false },
    { $set: { due: new Date().toISOString() } },
  );

  const openTasks = await tasks.find({ done: false }, { sort: { title: 1 } });
  console.log("Open tasks:", openTasks);

  const statusCounts = await tasks.countBy("done");
  console.log("Task counts:", statusCounts);

  await db.save();
  await db.close();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
