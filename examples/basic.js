"use strict";

const path = require("path");
const { JsonDatabase } = require("../src");

const run = async () => {
  const db = await JsonDatabase.open({
    path: path.resolve(__dirname, "../.examples/data"),
  });

  const tasks = db.collection("tasks", {
    validator: (doc) => {
      if (!doc.title) throw new Error("title is required");
    },
  });

  await tasks.insertOne({ title: "Prototype demo", done: false });
  await tasks.insertOne({ title: "Write docs", done: false });

  await tasks.updateMany(
    { done: false },
    { $set: { due: new Date().toISOString() } },
  );

  const openTasks = await tasks.find({ done: false }, { sort: { title: 1 } });
  console.log("Open tasks:", openTasks);

  await db.save();
  await db.close();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
