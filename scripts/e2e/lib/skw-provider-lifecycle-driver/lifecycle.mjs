// OpenClaw memory-core lifecycle exercise using the real SkwMemorySearchManager.
import crypto from "node:crypto";
import path from "node:path";
import { buildMemoryKey, makeSessionMappingProvider } from "./fixture.mjs";
import { LifecycleError, enrichError } from "./lifecycle-base.mjs";
import {
  checkAgentEndIdempotent,
  checkCompactions,
  checkEndSession,
  checkNoWriteTool,
  checkOldSessionCleanup,
  checkPersistentChildReuse,
  checkPrefetch,
  checkRead,
  checkSearch,
  checkStatus,
  checkSuccessor,
  checkWrites,
  readJournal,
} from "./lifecycle-checks.mjs";

export { LifecycleError, printOutcomes } from "./lifecycle-base.mjs";
export { buildMemoryKey, makeSessionMappingProvider };

/**
 * @typedef {import("./lifecycle-base.mjs").Outcome} Outcome
 * @typedef {import("./lifecycle-base.mjs").LifecycleResult} LifecycleResult
 */

/**
 * Run the full lifecycle against the manager.
 *
 * @param {object} deps
 * @param {import("../../../../extensions/memory-core/src/memory/skw-manager.ts").SkwMemorySearchManager} deps.manager
 * @param {string} deps.stateDir
 * @param {boolean} deps.expectAllOperations
 * @returns {Promise<LifecycleResult>}
 */
export async function runLifecycle({ manager, stateDir, expectAllOperations }) {
  const outcomes = [];
  const sessionId = "todo10-session";
  const sessionKey = "todo10-key";
  const nextSessionId = "todo10-session-next";
  const nextSessionKey = "todo10-key-next";
  const journalPath = path.join(stateDir, "fake-provider-journal.jsonl");

  function check(op, condition, message) {
    outcomes.push({ op, ok: condition, message });
    return condition;
  }

  function guard() {
    if (expectAllOperations && outcomes.some((o) => !o.ok)) {
      throw new LifecycleError(outcomes);
    }
  }

  async function noThrow(op, run, message) {
    try {
      await run();
      check(op, true, message);
    } catch (error) {
      check(op, false, `${message}: ${enrichError(error, manager, op)}`);
    }
  }

  await noThrow(
    "no-write-tool",
    () => checkNoWriteTool(),
    "memory tools do not include a write tool",
  );
  guard();
  checkStatus(manager.status(), check);
  guard();

  const handle = checkSearch(
    await manager.search("First line", { maxResults: 5, sources: ["memory"], sessionKey }),
    check,
  );
  guard();
  const pidBefore = manager.process?.child?.pid;

  checkRead(await manager.readFile({ relPath: handle, sessionKey }), check);
  guard();
  await noThrow(
    "prefetch",
    async () =>
      checkPrefetch(await manager.prefetch({ query: "First line", sessionKey, sessionId }), check),
    "prefetch succeeds",
  );
  guard();

  await noThrow(
    "memoryWrite",
    () =>
      manager.memoryWrite({
        eventId: uuid(),
        target: "user",
        content: "User prefers concise summaries.",
        metadata: {},
        sessionId,
        sessionKey,
      }),
    "operator memoryWrite user succeeds",
  );
  await noThrow(
    "memoryWrite-2",
    () =>
      manager.memoryWrite({
        eventId: uuid(),
        target: "general",
        content: "Project uses SQLite.",
        metadata: {},
        sessionId,
        sessionKey,
      }),
    "operator memoryWrite general succeeds",
  );
  guard();

  const agentEndEventId = uuid();
  await noThrow(
    "agentEnd",
    () =>
      manager.agentEnd({
        eventId: agentEndEventId,
        success: true,
        messages: [{ role: "user", text: "I prefer concise summaries." }],
        durationMs: 1234,
        sessionId,
        sessionKey,
      }),
    "successful agentEnd succeeds",
  );
  guard();
  await checkAgentEndIdempotent(manager, agentEndEventId, sessionId, sessionKey, check);
  guard();
  await noThrow(
    "agentEnd-failed",
    () =>
      manager.agentEnd({
        eventId: uuid(),
        success: false,
        messages: [{ role: "user", text: "I prefer concise summaries." }],
        sessionId,
        sessionKey,
      }),
    "failed agentEnd succeeds",
  );
  guard();

  const compactionId = uuid();
  await noThrow(
    "prepareCompaction",
    () =>
      manager.prepareCompaction({
        compactionId,
        messages: [],
        maxCharacters: 8192,
        sessionId,
        sessionKey,
      }),
    "prepareCompaction succeeds",
  );
  await noThrow(
    "finishCompaction",
    () =>
      manager.finishCompaction({
        compactionId,
        outcome: "success",
        compactedCount: 0,
        sessionId,
        sessionKey,
      }),
    "finishCompaction success succeeds",
  );
  guard();
  const compactionIdFailed = uuid();
  await noThrow(
    "prepareCompaction-failed",
    () =>
      manager.prepareCompaction({
        compactionId: compactionIdFailed,
        messages: [],
        maxCharacters: 8192,
        sessionId,
        sessionKey,
      }),
    "failed prepareCompaction succeeds",
  );
  await noThrow(
    "finishCompaction-failed",
    () =>
      manager.finishCompaction({
        compactionId: compactionIdFailed,
        outcome: "failed",
        sessionId,
        sessionKey,
      }),
    "finishCompaction failure succeeds",
  );
  guard();

  await noThrow(
    "endSession",
    () =>
      manager.endSession({ reason: "new", nextSessionId, nextSessionKey, sessionId, sessionKey }),
    "endSession succeeds",
  );
  guard();
  checkSuccessor(
    await manager.search("First line", {
      maxResults: 1,
      sources: ["memory"],
      sessionKey: nextSessionKey,
    }),
    check,
  );
  guard();
  await checkOldSessionCleanup(manager, sessionKey, sessionId, check);
  guard();

  checkPersistentChildReuse(pidBefore, manager.process?.child?.pid, check);
  const journal = readJournal(journalPath);
  if (journal.length > 0) {
    checkWrites(check, journal);
    checkCompactions(check, journal);
    checkEndSession(check, journal);
  }

  const allPassed = outcomes.every((o) => o.ok);
  if (expectAllOperations && !allPassed) {
    throw new LifecycleError(outcomes);
  }
  return { outcomes, allPassed };
}

function uuid() {
  return crypto.randomUUID();
}
