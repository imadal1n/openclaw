// Status and lifecycle-state checks for the SKW provider runner.

/**
 * Check the memory-core tools registered for model use contain no write tool.
 * @returns {Promise<void>}
 */
export async function checkNoWriteTool() {
  const { createMemorySearchTool } =
    await import("../../../../extensions/memory-core/src/tools.ts");
  const { createMemoryGetTool } = await import("../../../../extensions/memory-core/src/tools.ts");
  const searchTool = createMemoryGetTool({});
  const getTool = createMemorySearchTool({});
  const names = [searchTool?.name, getTool?.name].filter(Boolean);
  if (names.some((name) => /write/i.test(name))) {
    throw new Error(`memory tool names include a write tool: ${names.join(", ")}`);
  }
}

/**
 * Check manager status payload.
 * @param {Record<string, unknown>} status
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 */
export function checkStatus(status, check) {
  check("status", status.provider === "skw", "status provider is skw");
  check("status-ready", status.vector?.available === true, "status reports vector available");
  check(
    "status-identity",
    status.custom?.skw?.agentId === "todo10-agent" && status.custom?.skw?.profile === "fixture",
    "status identity is exact",
  );
}

/**
 * Check persistent child reuse by comparing PIDs before/after the lifecycle.
 * @param {number | undefined} pidBefore
 * @param {number | undefined} pidAfter
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 */
export function checkPersistentChildReuse(pidBefore, pidAfter, check) {
  check(
    "persistent-child",
    Boolean(pidBefore) && pidBefore === pidAfter,
    `manager reused the same provider process (${pidBefore} === ${pidAfter})`,
  );
}

/**
 * Check zero owned child after manager close.
 * @param {boolean} alive
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 */
export function checkNoChildAfterClose(alive, check) {
  check("no-child-after-close", !alive, "provider child is no longer alive after manager close");
}

/**
 * Check that an empty/stale state error names the failing operation and reason.
 * @param {Error} error
 * @param {string} expectedOp
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 */
export function checkEmptyStateError(error, expectedOp, check) {
  const message = error.message;
  check(
    "empty-state-error",
    /initialize|database|not found|state|sqlite/i.test(message),
    `empty/stale state error names operation and reason: ${message}`,
  );
}
