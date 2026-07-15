// Strict OpenClaw provider v1 NDJSON framing helpers.
import assert from "node:assert";

export const MAX_FRAME_BYTES = 1024 * 1024;

export const ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "DENIED",
  "UNAVAILABLE",
  "TIMEOUT",
  "ABORTED",
  "MALFORMED_OUTPUT",
  "OUTPUT_LIMIT",
  "INTERNAL",
]);

export const OPS_REQUIRING_SESSION = new Set([
  "search",
  "read",
  "prefetch",
  "memoryWrite",
  "agentEnd",
  "prepareCompaction",
  "finishCompaction",
  "endSession",
]);

export const OPS_WITH_VOID_RESULT = new Set([
  "memoryWrite",
  "agentEnd",
  "prepareCompaction",
  "finishCompaction",
  "endSession",
  "shutdown",
]);

/**
 * @typedef {object} Identity
 * @property {string} agentId
 * @property {string} profile
 * @property {string} [sessionId]
 * @property {string} [sessionKey]
 */

/**
 * Build a strict v1 NDJSON request frame.
 * @param {string} op
 * @param {string} id
 * @param {Identity} identity
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function buildFrame(op, id, identity, params) {
  const envelope = {
    version: 1,
    id,
    op,
    identity: {
      agentId: identity.agentId,
      profile: identity.profile,
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      ...(identity.sessionKey ? { sessionKey: identity.sessionKey } : {}),
    },
    params: params ?? {},
  };
  const sorted = Object.fromEntries(
    Object.keys(envelope)
      .toSorted()
      .map((key) => [key, envelope[key]]),
  );
  const line = JSON.stringify(sorted) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(`request frame exceeded ${MAX_FRAME_BYTES} bytes`);
  }
  return line;
}

/**
 * Parse and validate one NDJSON response line.
 * @param {string} line
 * @returns {Record<string, unknown>}
 */
export function parseFrame(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch (cause) {
    throw new Error(`invalid JSON response: ${String(cause)}`, { cause });
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("response is not a JSON object");
  }
  const allowed = new Set(["version", "id", "ok", "result", "error"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`response contains unknown keys: ${unknown.join(", ")}`);
  }
  if (raw.version !== 1) {
    throw new Error(`response version must be 1, got ${String(raw.version)}`);
  }
  if (typeof raw.id !== "string") {
    throw new Error(`response id must be a string, got ${typeof raw.id}`);
  }
  if (typeof raw.ok !== "boolean") {
    throw new Error(`response ok must be a boolean, got ${typeof raw.ok}`);
  }
  if (raw.ok) {
    if (raw.error !== undefined) {
      throw new Error("success response must not contain error");
    }
    if (raw.result === undefined) {
      throw new Error("success response must contain result");
    }
  } else {
    if (raw.result !== undefined) {
      throw new Error("error response must not contain result");
    }
    validateError(raw.error);
  }
  return raw;
}

function validateError(error) {
  if (!error || typeof error !== "object") {
    throw new Error("error response must contain an error object");
  }
  if (typeof error.code !== "string" || !ERROR_CODES.has(error.code)) {
    throw new Error(`error response has invalid code: ${String(error.code)}`);
  }
  if (typeof error.message !== "string") {
    throw new Error("error response message must be a string");
  }
  if (error.retryable !== undefined && typeof error.retryable !== "boolean") {
    throw new Error("error response retryable must be a boolean");
  }
}

/**
 * Ensure a response frame matches the expected request id and success shape.
 * @param {Record<string, unknown>} frame
 * @param {string} expectedId
 * @param {string} op
 * @returns {Record<string, unknown>}
 */
export function expectSuccess(frame, expectedId, op) {
  assert.equal(frame.id, expectedId, `response id mismatch for ${op}`);
  assert.equal(frame.ok, true, `expected success for ${op}: ${JSON.stringify(frame.error)}`);
  assert.ok(frame.result && typeof frame.result === "object", `expected result object for ${op}`);
  return /** @type {Record<string, unknown>} */ (frame.result);
}

/**
 * Ensure a response frame is an expected error.
 * @param {Record<string, unknown>} frame
 * @param {string} expectedId
 * @param {string} expectedCode
 * @param {string} op
 * @returns {Record<string, unknown>}
 */
export function expectError(frame, expectedId, expectedCode, op) {
  assert.equal(frame.id, expectedId, `response id mismatch for ${op}`);
  assert.equal(frame.ok, false, `expected error for ${op}`);
  const error = /** @type {{code: string, message: string}} */ (frame.error);
  assert.equal(error.code, expectedCode, `expected ${expectedCode} for ${op}, got ${error.code}`);
  return error;
}

/**
 * Format a driver outcome line.
 * @param {string} op
 * @param {boolean} ok
 * @param {string} message
 * @returns {string}
 */
export function formatOutcome(op, ok, message) {
  return `${ok ? "PASS" : "FAIL"} ${op}: ${message}`;
}

/**
 * Build a request identity with optional session fields.
 * @param {string} agentId
 * @param {string} profile
 * @param {string} [sessionId]
 * @param {string} [sessionKey]
 * @returns {Identity}
 */
export function makeIdentity(agentId, profile, sessionId, sessionKey) {
  return { agentId, profile, sessionId, sessionKey };
}
