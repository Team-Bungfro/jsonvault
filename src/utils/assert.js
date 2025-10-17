"use strict";

const { JsonVaultError } = require("../errors");

const invariant = (condition, message, details) => {
  if (!condition) {
    throw new JsonVaultError(message, details);
  }
};

module.exports = {
  invariant,
};
