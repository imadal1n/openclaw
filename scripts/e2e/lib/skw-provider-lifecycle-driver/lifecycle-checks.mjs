// Focused check helpers for the SKW provider lifecycle runner (manager-backed).
export { checkCompactions, checkEndSession, checkWrites, readJournal } from "./checks-journal.mjs";
export {
  checkEmptyStateError,
  checkNoChildAfterClose,
  checkNoWriteTool,
  checkPersistentChildReuse,
  checkStatus,
} from "./checks-status.mjs";

/**
 * Check search response and return the first result handle.
 * @param {Record<string, unknown>[]} results
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 * @returns {string}
 */
export function checkSearch(results, check) {
  check("search", results.length >= 1, "search returns at least one result");
  const handle = typeof results[0]?.path === "string" ? String(results[0].path) : "";
  check("search-handle", handle.startsWith("skw://v1/"), "search result has signed handle prefix");
  check(
    "search-source",
    results.every((r) => r.source === "memory"),
    "all results source is memory",
  );
  check(
    "search-no-fallback",
    results.every((r) => r.source !== "builtin"),
    "no builtin fallback results",
  );
  return handle;
}

/**
 * Check read response.
 * @param {Record<string, unknown>} read
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 */
export function checkRead(read, check) {
  check("read", typeof read.text === "string", "read returns text");
  check(
    "read-text",
    String(read.text).includes("First line"),
    "read text contains expected content",
  );
  check(
    "read-no-prompt-injection",
    !String(read.text).includes("SYSTEM:"),
    "read text does not contain prompt injection",
  );
}

/**
 * Check prefetch response.
 * @param {Record<string, unknown>} prefetch
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 */
export function checkPrefetch(prefetch, check) {
  check(
    "prefetch",
    ["fast", "cached-full", "abstain"].includes(String(prefetch.quality)),
    "prefetch quality is valid",
  );
  check("prefetch-no-fallback", typeof prefetch.context === "string", "prefetch returns context");
}

/**
 * Check that a repeated agentEnd with the same eventId is idempotent.
 * @param {import("../../../../extensions/memory-core/src/memory/skw-manager.ts").SkwMemorySearchManager} manager
 * @param {string} eventId
 * @param {string} sessionId
 * @param {string} sessionKey
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 * @returns {Promise<void>}
 */
export async function checkAgentEndIdempotent(manager, eventId, sessionId, sessionKey, check) {
  try {
    await manager.agentEnd({
      eventId,
      success: true,
      messages: [{ role: "user", text: "I prefer concise summaries." }],
      durationMs: 1234,
      sessionId,
      sessionKey,
    });
    check("agentEnd-idempotent", true, "repeated same eventId agentEnd is idempotent");
  } catch (error) {
    check(
      "agentEnd-idempotent",
      false,
      `repeated agentEnd failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Check successor search response.
 * @param {Record<string, unknown>[]} successorResults
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 */
export function checkSuccessor(successorResults, check) {
  check("successor-search", successorResults.length >= 1, "successor session can search");
}

/**
 * Check that the old session is no longer usable after endSession.
 * @param {import("../../../../extensions/memory-core/src/memory/skw-manager.ts").SkwMemorySearchManager} manager
 * @param {string} sessionKey
 * @param {string} sessionId
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 * @returns {Promise<void>}
 */
export async function checkOldSessionCleanup(manager, sessionKey, sessionId, check) {
  try {
    await manager.search("First line", { maxResults: 1, sources: ["memory"], sessionKey });
    check(
      "old-session-cleanup",
      false,
      "old session search unexpectedly succeeded after endSession",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      "old-session-cleanup",
      /DENIED|session|no longer active|cleanup/i.test(message),
      `old session operation fails after endSession: ${message}`,
    );
  }
}
