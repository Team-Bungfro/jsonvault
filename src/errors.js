"use strict";

class JsonVaultError extends Error {
  constructor(message, details = {}, code = JsonVaultError.code) {
    super(message || "JsonVault error");
    this.name = new.target.name;
    this.details = details;
    this.code = code || JsonVaultError.code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

JsonVaultError.code = "ERR_JSONVAULT";

class InvalidArgumentError extends JsonVaultError {
  constructor(message, details = {}) {
    super(message || "Invalid argument", details, InvalidArgumentError.code);
  }
}

InvalidArgumentError.code = "ERR_INVALID_ARGUMENT";

class InvalidOperationError extends JsonVaultError {
  constructor(message, details = {}) {
    super(message || "Invalid operation", details, InvalidOperationError.code);
  }
}

InvalidOperationError.code = "ERR_INVALID_OPERATION";

class NotFoundError extends JsonVaultError {
  constructor(message, details = {}) {
    super(message || "Resource not found", details, NotFoundError.code);
  }
}

NotFoundError.code = "ERR_NOT_FOUND";

class AlreadyExistsError extends JsonVaultError {
  constructor(message, details = {}) {
    super(message || "Resource already exists", details, AlreadyExistsError.code);
  }
}

AlreadyExistsError.code = "ERR_ALREADY_EXISTS";

class QueryError extends JsonVaultError {
  constructor(message, details = {}) {
    super(message || "Query failed", details, QueryError.code);
  }
}

QueryError.code = "ERR_QUERY";

class PolicyDeniedError extends JsonVaultError {
  constructor(message, details = {}) {
    super(message || "Policy denied the requested operation", details, PolicyDeniedError.code);
  }
}

PolicyDeniedError.code = "ERR_POLICY_DENIED";

module.exports = {
  JsonVaultError,
  InvalidArgumentError,
  InvalidOperationError,
  NotFoundError,
  AlreadyExistsError,
  QueryError,
  PolicyDeniedError,
};
