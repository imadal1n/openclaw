// Journal-backed checks for the SKW lifecycle runner.
import { readFileSync } from "node:fs";

/**
 * Read and parse the fake-provider journal if it exists.
 * @param {string} journalPath
 * @returns {Array<Record<string, unknown>>}
 */
export function readJournal(journalPath) {
  try {
    const text = readFileSync(journalPath, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Check operator memory writes are not model-visible.
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 * @param {Array<Record<string, unknown>>} journal
 */
export function checkWrites(check, journal) {
  const writes = journal.filter((entry) => entry.op === "memoryWrite" && entry.ok === true);
  check(
    "memoryWrite-operator",
    writes.length >= 1,
    `memoryWrite was invoked as operator-only (${writes.length} successful journal entries)`,
  );
}

/**
 * Check compaction success and failure responses from the journal.
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 * @param {Array<Record<string, unknown>>} journal
 */
export function checkCompactions(check, journal) {
  const prepares = journal.filter((entry) => entry.op === "prepareCompaction" && entry.ok === true);
  const finishes = journal.filter((entry) => entry.op === "finishCompaction" && entry.ok === true);
  check("prepareCompaction", prepares.length >= 1, "prepareCompaction journal entry exists");
  check(
    "finishCompaction",
    finishes.some((entry) => entry.outcome === "success"),
    "finishCompaction success journal entry exists",
  );
  check(
    "prepareCompaction-failed",
    prepares.length >= 2,
    "failed prepareCompaction journal entry exists",
  );
  check(
    "finishCompaction-failed",
    finishes.some((entry) => entry.outcome === "failed"),
    "finishCompaction failure journal entry exists",
  );
}

/**
 * Check endSession response and successor acceptance from the journal.
 * @param {(op: string, condition: boolean, message: string) => boolean} check
 * @param {Array<Record<string, unknown>>} journal
 */
export function checkEndSession(check, journal) {
  check(
    "endSession",
    journal.some((entry) => entry.op === "endSession" && entry.ok === true),
    "endSession journal entry exists",
  );
  check(
    "endSession-successor",
    journal.some(
      (entry) =>
        entry.op === "search" && entry.ok === true && entry.sessionKey === "todo10-key-next",
    ),
    "endSession accepted successor session identity",
  );
}
