/**
 * Subagent registry state persistence bridge.
 *
 * Merges process-local active runs with persisted SQLite state for cross-process readers.
 */
import fs from "node:fs";
import path from "node:path";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import { resolveSubagentRegistryPath } from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_RUNS_READ_CACHE_TTL_MS = 500;
const COMPLETED_SUBAGENT_RESULTS_RETENTION_MS = 24 * 60 * 60 * 1000;
const COMPLETED_SUBAGENT_RESULTS_MAX_ENTRIES = 200;
const COMPLETED_SUBAGENT_RESULTS_MAX_BYTES = 2 * 1024 * 1024;
const COMPLETED_SUBAGENT_RESULT_TEXT_MAX_BYTES = 32 * 1024;

type PersistedCompletedSubagentResults = {
  version: 1;
  updatedAt: number;
  runs: Record<string, SubagentRunRecord>;
};

let persistedSubagentRunsReadCache:
  | {
      loadedAtMs: number;
      runs: Map<string, SubagentRunRecord>;
    }
  | undefined;

function cloneSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs.entries()].map(([runId, entry]) => [runId, structuredClone(entry)]));
}

function rememberPersistedSubagentRunsSnapshot(runs: Map<string, SubagentRunRecord>): void {
  persistedSubagentRunsReadCache = {
    loadedAtMs: Date.now(),
    runs: cloneSubagentRunsSnapshot(runs),
  };
}

function loadPersistedSubagentRunsForRead(): Map<string, SubagentRunRecord> {
  const nowMs = Date.now();
  if (
    persistedSubagentRunsReadCache &&
    nowMs >= persistedSubagentRunsReadCache.loadedAtMs &&
    nowMs - persistedSubagentRunsReadCache.loadedAtMs < SUBAGENT_RUNS_READ_CACHE_TTL_MS
  ) {
    return persistedSubagentRunsReadCache.runs;
  }

  const runs = loadSubagentRegistryFromSqlite();
  persistedSubagentRunsReadCache = {
    loadedAtMs: nowMs,
    runs,
  };
  return runs;
}

export function clearSubagentRunsReadCacheForTest(): void {
  persistedSubagentRunsReadCache = undefined;
}

function resolveCompletedSubagentResultsPath(): string {
  return path.join(path.dirname(resolveSubagentRegistryPath()), "completed-results.json");
}

function isCompletedSubagentRunEntry(entry: unknown): entry is SubagentRunRecord {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as Partial<SubagentRunRecord>;
  return (
    typeof record.runId === "string" &&
    typeof record.childSessionKey === "string" &&
    typeof record.requesterSessionKey === "string" &&
    typeof record.endedAt === "number" &&
    Number.isFinite(record.endedAt)
  );
}

function trimCompletedSubagentResult(entry: SubagentRunRecord): SubagentRunRecord {
  const cloned = structuredClone(entry);
  const truncateResultText = (value: string): string => {
    let text = value;
    while (Buffer.byteLength(text, "utf8") > COMPLETED_SUBAGENT_RESULT_TEXT_MAX_BYTES) {
      text = text.slice(0, Math.max(0, text.length - 1024));
    }
    return `${text}\n[truncated by completed subagent result persistence]`;
  };

  const completionText = cloned.completion?.resultText;
  if (
    typeof completionText === "string" &&
    Buffer.byteLength(completionText, "utf8") > COMPLETED_SUBAGENT_RESULT_TEXT_MAX_BYTES
  ) {
    if (cloned.completion) {
      cloned.completion.resultText = truncateResultText(completionText);
    }
  }

  const deliveryText = cloned.delivery?.payload?.frozenResultText;
  if (
    typeof deliveryText === "string" &&
    Buffer.byteLength(deliveryText, "utf8") > COMPLETED_SUBAGENT_RESULT_TEXT_MAX_BYTES
  ) {
    if (cloned.delivery?.payload) {
      cloned.delivery.payload.frozenResultText = truncateResultText(deliveryText);
    }
  }

  const fallbackDeliveryText = cloned.delivery?.payload?.fallbackFrozenResultText;
  if (
    typeof fallbackDeliveryText === "string" &&
    Buffer.byteLength(fallbackDeliveryText, "utf8") > COMPLETED_SUBAGENT_RESULT_TEXT_MAX_BYTES
  ) {
    if (cloned.delivery?.payload) {
      cloned.delivery.payload.fallbackFrozenResultText = truncateResultText(fallbackDeliveryText);
    }
  }
  return cloned;
}

function sortCompletedSubagentResultEntries(entries: Array<[string, SubagentRunRecord]>) {
  return entries.toSorted(
    (left, right) =>
      (right[1].endedAt ?? right[1].createdAt ?? 0) - (left[1].endedAt ?? left[1].createdAt ?? 0),
  );
}

function loadCompletedSubagentResultsFromDisk(now = Date.now()): Map<string, SubagentRunRecord> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(resolveCompletedSubagentResultsPath(), "utf8"),
    ) as Partial<PersistedCompletedSubagentResults> | null;
    if (!raw || raw.version !== 1 || !raw.runs || typeof raw.runs !== "object") {
      return new Map();
    }
    const out = new Map<string, SubagentRunRecord>();
    for (const [runId, entry] of Object.entries(raw.runs)) {
      if (!isCompletedSubagentRunEntry(entry)) {
        continue;
      }
      const retentionBase =
        typeof entry.cleanupCompletedAt === "number" ? entry.cleanupCompletedAt : entry.endedAt;
      if (
        typeof retentionBase !== "number" ||
        now - retentionBase > COMPLETED_SUBAGENT_RESULTS_RETENTION_MS
      ) {
        continue;
      }
      out.set(runId, structuredClone(entry));
    }
    return out;
  } catch {
    return new Map();
  }
}

export function saveCompletedSubagentRunToDisk(entry: SubagentRunRecord) {
  try {
    if (!isCompletedSubagentRunEntry(entry)) {
      return;
    }
    const pathname = resolveCompletedSubagentResultsPath();
    const dir = path.dirname(pathname);
    fs.mkdirSync(dir, { recursive: true });
    const lockDir = path.join(dir, ".completed-results.lock");
    try {
      fs.mkdirSync(lockDir);
    } catch {
      return;
    }
    try {
      const now = Date.now();
      const runs = loadCompletedSubagentResultsFromDisk(now);
      runs.set(entry.runId, trimCompletedSubagentResult(entry));
      const selected: Record<string, SubagentRunRecord> = {};
      for (const [runId, value] of sortCompletedSubagentResultEntries([...runs.entries()])) {
        if (Object.keys(selected).length >= COMPLETED_SUBAGENT_RESULTS_MAX_ENTRIES) {
          break;
        }
        selected[runId] = value;
        const candidate = JSON.stringify({ version: 1, updatedAt: now, runs: selected });
        if (Buffer.byteLength(candidate, "utf8") > COMPLETED_SUBAGENT_RESULTS_MAX_BYTES) {
          delete selected[runId];
          break;
        }
      }
      const tmp = path.join(dir, `.completed-results-${process.pid}-${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: now, runs: selected }), "utf8");
      fs.renameSync(tmp, pathname);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // ignore persistence failures
  }
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  try {
    saveSubagentRegistryToSqlite(runs);
    rememberPersistedSubagentRunsSnapshot(runs);
  } catch {
    // ignore persistence failures
  }
}

export function persistSubagentRunsToDiskOrThrow(runs: Map<string, SubagentRunRecord>) {
  saveSubagentRegistryToSqlite(runs);
  rememberPersistedSubagentRunsSnapshot(runs);
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  if (restored.size === 0) {
    return 0;
  }
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    added += 1;
  }
  return added;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk =
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      // Persisted state lets other worker processes observe active runs.
      // Cache this hot cross-process snapshot briefly; writes refresh the local
      // cache and the TTL bounds visibility of changes from other processes.
      for (const [runId, entry] of loadCompletedSubagentResultsFromDisk().entries()) {
        merged.set(runId, entry);
      }
      for (const [runId, entry] of loadPersistedSubagentRunsForRead().entries()) {
        merged.set(runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}
