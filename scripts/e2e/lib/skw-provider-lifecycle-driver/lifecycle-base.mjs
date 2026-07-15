// Base helpers shared by the SKW lifecycle runner modules.

/**
 * @typedef {object} Outcome
 * @property {string} op
 * @property {boolean} ok
 * @property {string} message
 */

/**
 * @typedef {object} LifecycleResult
 * @property {Outcome[]} outcomes
 * @property {boolean} allPassed
 */

export class LifecycleError extends Error {
  /**
   * @param {Outcome[]} outcomes
   */
  constructor(outcomes) {
    super("lifecycle driver failed one or more operation checks");
    this.outcomes = outcomes;
  }
}

/**
 * Print outcomes to a stream.
 * @param {Outcome[]} outcomes
 * @param {{write: (line: string) => void}} destination
 */
export function printOutcomes(outcomes, destination) {
  for (const outcome of outcomes) {
    destination.write(`${formatOutcome(outcome.op, outcome.ok, outcome.message)}\n`);
  }
}

/**
 * @param {string} op
 * @param {boolean} ok
 * @param {string} message
 * @returns {string}
 */
function formatOutcome(op, ok, message) {
  return `${ok ? "PASS" : "FAIL"} ${op}: ${message}`;
}

/**
 * Enrich an error with pending operation and stderr context without leaking secrets.
 * @param {unknown} error
 * @param {import("../../../../extensions/memory-core/src/memory/skw-manager.ts").SkwMemorySearchManager} manager
 * @param {string} op
 * @returns {string}
 */
export function enrichError(error, manager, op) {
  const base = error instanceof Error ? error.message : String(error);
  const process = manager.process;
  const activeOp = process?.activeRequest?.op;
  const activeId = process?.activeRequest?.id;
  const stderr = process?.lastStderr?.slice(-500) ?? "";
  const exitCode = process?.child?.exitCode ?? null;
  const signalCode = process?.child?.signalCode ?? null;
  const parts = [`op=${op}`];
  if (activeOp) {
    parts.push(`pendingOp=${activeOp}`);
  }
  if (activeId) {
    parts.push(`pendingId=${activeId}`);
  }
  if (exitCode !== null) {
    parts.push(`exitCode=${exitCode}`);
  }
  if (signalCode) {
    parts.push(`signal=${signalCode}`);
  }
  if (stderr) {
    // Keep only the tail and strip any absolute paths that might contain secrets.
    const tail = stderr.replace(/\/[^\s]+/g, "<path>").slice(-200);
    parts.push(`stderr=${tail}`);
  }
  return `${base} [${parts.join("; ")}]`;
}
