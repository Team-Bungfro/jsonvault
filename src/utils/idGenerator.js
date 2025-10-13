"use strict";

const { randomUUID } = require("crypto");

const generateId = () => {
  if (typeof randomUUID === "function") {
    return randomUUID();
  }

  const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const timestamp = Date.now().toString(16);
  return `${timestamp}-${random.toString(16)}`;
};

module.exports = {
  generateId,
};
