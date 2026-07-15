// Direct process helpers are retired; the lifecycle is owned by SkwMemorySearchManager
// through skwProviderPool and SkwProviderProcess. This file now only exports a diagnostic
// formatter for provider-close errors and re-exports the liveness helper.

import { isProcessAlive } from "./process-lifecycle.mjs";

export { isProcessAlive };

/**
 * Format a rich provider-close diagnostic that names the pending operation and id,
 * includes captured stderr/exit context, and avoids leaking secrets.
 *
 * @param {Error} error
 * @param {object} context
 * @param {string} context.op
 * @param {string | undefined} context.pendingOp
 * @param {string | undefined} context.pendingId
 * @param {string | undefined} context.stderr
 * @param {number | null} context.exitCode
 * @param {string | null} context.signalCode
 * @returns {string}
 */
export function formatProviderCloseError(error, context) {
  const base = error instanceof Error ? error.message : String(error);
  const parts = [`op=${context.op}`];
  if (context.pendingOp) {
    parts.push(`pendingOp=${context.pendingOp}`);
  }
  if (context.pendingId) {
    parts.push(`pendingId=${context.pendingId}`);
  }
  if (context.exitCode !== null) {
    parts.push(`exitCode=${context.exitCode}`);
  }
  if (context.signalCode) {
    parts.push(`signal=${context.signalCode}`);
  }
  if (context.stderr) {
    // Keep only the tail and strip any paths that might contain secrets.
    const tail = context.stderr.slice(-500).replace(/\/[^\s]+/g, "<path>");
    parts.push(`stderr=${tail}`);
  }
  return `${base} [${parts.join("; ")}]`;
}

/**
 * @deprecated Direct process ownership is retired; use SkwMemorySearchManager.
 */
export function spawnProvider() {
  throw new Error("Direct process helpers are retired; use SkwMemorySearchManager");
}

/**
 * @deprecated Direct process ownership is retired; use SkwMemorySearchManager.
 */
export function request() {
  throw new Error("Direct process helpers are retired; use SkwMemorySearchManager");
}

/**
 * @deprecated Direct process ownership is retired; use SkwMemorySearchManager.
 */
export function shutdown() {
  throw new Error("Direct process helpers are retired; use SkwMemorySearchManager");
}

/**
 * @deprecated Direct process ownership is retired; use SkwMemorySearchManager.
 */
export function providerPid() {
  throw new Error("Direct process helpers are retired; use SkwMemorySearchManager");
}

/**
 * @deprecated Direct process ownership is retired; use SkwMemorySearchManager.
 */
export async function readStderr() {
  throw new Error("Direct process helpers are retired; use SkwMemorySearchManager");
}
