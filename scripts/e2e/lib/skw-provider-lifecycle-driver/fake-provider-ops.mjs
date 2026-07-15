// Operation handlers for the fake strict OpenClaw SKW provider.
import crypto from "node:crypto";

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

/**
 * Handle a single operation and return the response frame.
 * @param {string} op
 * @param {string} id
 * @param {object} identity
 * @param {object} params
 * @param {object} state
 * @param {Map<string, string>} state.sessions
 * @param {Map<string, unknown>} state.idempotency
 * @param {object | undefined} state.initParams
 * @param {string} state.FAULT_TEXT
 * @returns {object}
 */
export function handleOperation(op, id, identity, params, state) {
  const { FAULT_TEXT, initParams } = state;
  switch (op) {
    case "initialize": {
      state.initParams = params;
      return {
        version: 1,
        id,
        ok: true,
        result: {
          provider: "skw",
          protocolVersion: 1,
          ready: true,
          capabilities: {
            search: true,
            read: true,
            prefetch: true,
            write: true,
            extraction: true,
            compaction: true,
            vector: true,
          },
        },
      };
    }
    case "status": {
      return {
        version: 1,
        id,
        ok: true,
        result: {
          ready: true,
          protocolVersion: 1,
          profile: identity.profile,
          databasePath: initParams?.databasePath ?? "",
          memoryDatabasePath: initParams?.memoryDatabasePath ?? "",
        },
      };
    }
    case "search": {
      return {
        version: 1,
        id,
        ok: true,
        result: {
          results: [
            {
              path: "skw://v1/fake-chunk-1",
              displayPath: "doc.md",
              startLine: 1,
              endLine: 1,
              score: 1,
              snippet: "First line.",
              source: "memory",
              metadata: { displayPath: "doc.md" },
            },
          ],
        },
      };
    }
    case "read": {
      return {
        version: 1,
        id,
        ok: true,
        result: {
          path: params?.relPath ?? params?.handle ?? "",
          displayPath: "doc.md",
          text: FAULT_TEXT || "First line.",
          truncated: false,
          from: 1,
          lines: 1,
        },
      };
    }
    case "prefetch": {
      return {
        version: 1,
        id,
        ok: true,
        result: { context: "", quality: "fast", cacheKeyHash: "deadbeef", queued: false },
      };
    }
    case "memoryWrite": {
      if (!params?.eventId || !params?.target || typeof params?.content !== "string") {
        return {
          version: 1,
          id,
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "memoryWrite requires eventId, target, content",
          },
        };
      }
      if (
        params?.target !== "user" &&
        params?.target !== "general" &&
        params?.target !== "project"
      ) {
        return {
          version: 1,
          id,
          ok: false,
          error: { code: "INVALID_REQUEST", message: "invalid target" },
        };
      }
      if (state.idempotency.has(params.eventId)) {
        return { version: 1, id, ok: true, result: state.idempotency.get(params.eventId) };
      }
      const result = { written: true, factId: crypto.randomUUID() };
      state.idempotency.set(params.eventId, result);
      return { version: 1, id, ok: true, result };
    }
    case "agentEnd": {
      const eventId = params?.eventId;
      if (eventId && state.idempotency.has(eventId)) {
        return { version: 1, id, ok: true, result: state.idempotency.get(eventId) };
      }
      const success = params?.success === true;
      const result = { proposalsCreated: success ? 1 : 0 };
      if (eventId) {
        state.idempotency.set(eventId, result);
      }
      return { version: 1, id, ok: true, result };
    }
    case "prepareCompaction": {
      return { version: 1, id, ok: true, result: { preservationContext: "context" } };
    }
    case "finishCompaction": {
      return { version: 1, id, ok: true, result: { ok: true } };
    }
    case "endSession": {
      return { version: 1, id, ok: true, result: { cancelledJobs: 0, releasedEntries: 1 } };
    }
    case "shutdown": {
      return { version: 1, id, ok: true, result: { ok: true } };
    }
    default: {
      return {
        version: 1,
        id,
        ok: false,
        error: { code: "INVALID_REQUEST", message: `unsupported operation: ${op}` },
      };
    }
  }
}
