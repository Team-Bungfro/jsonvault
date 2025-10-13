"use strict";

const invariant = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

module.exports = {
  invariant,
};
