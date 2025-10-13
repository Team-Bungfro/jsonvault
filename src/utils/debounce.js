"use strict";

const debounce = (fn, wait) => {
  let timeout = null;
  let pendingPromise = null;

  const debounced = (...args) => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(async () => {
      timeout = null;
      try {
        pendingPromise = Promise.resolve(fn(...args));
        await pendingPromise;
      } finally {
        pendingPromise = null;
      }
    }, wait);
  };

  debounced.flush = async () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
      pendingPromise = Promise.resolve(fn());
      await pendingPromise;
      pendingPromise = null;
    } else if (pendingPromise) {
      await pendingPromise;
    }
  };

  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    pendingPromise = null;
  };

  return debounced;
};

module.exports = debounce;
