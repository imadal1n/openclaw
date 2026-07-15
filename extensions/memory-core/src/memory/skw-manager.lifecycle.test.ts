// Tests for SKW memory manager lifecycle methods.
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ID,
  SKW_PROFILE,
  closeTrackedManagers,
  createManagerFactory,
  emitFrame,
  respondToOperation,
  waitForOperationFrame,
} from "./__fixtures__/skw/skw-manager-test-harness.js";
import { SkwMemorySearchManager } from "./skw-manager.js";
import { SkwProviderError } from "./skw-provider-framing.js";
import { skwProviderPool } from "./skw-provider-pool.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});
const createManager = createManagerFactory(SkwMemorySearchManager, spawnMock);

describe("SkwMemorySearchManager lifecycle methods", () => {
  beforeEach(() => spawnMock.mockReset());

  afterEach(async () => {
    await closeTrackedManagers();
    await skwProviderPool.closeAll();
  });

  it("sends memoryWrite with eventId, target, content, and metadata", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.memoryWrite({
      eventId: "evt-1",
      target: "user",
      content: "hello world",
      metadata: { category: "user_pref" },
    });
    const frame = await respondToOperation(stdout, stdin, "memoryWrite", {});
    await respondToOperation(stdout, stdin, "status", {
      capabilities: { embedding: true, vector: true },
    });
    await promise;

    expect(frame).toMatchObject({
      version: 1,
      op: "memoryWrite",
      identity: { agentId: AGENT_ID, profile: SKW_PROFILE },
    });
    expect(frame.params).toEqual({
      eventId: "evt-1",
      target: "user",
      content: "hello world",
      metadata: { category: "user_pref" },
    });
  });

  it("binds sessionId and sessionKey to memoryWrite identity", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.memoryWrite({
      eventId: "evt-2",
      target: "general",
      content: "session note",
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await waitForOperationFrame(stdin, "memoryWrite");
    emitFrame(stdout, { version: 1, id: frame.id, ok: true, result: {} });
    await respondToOperation(stdout, stdin, "status", {
      capabilities: { embedding: true, vector: true },
    });
    await promise;

    expect(frame.identity).toEqual({
      agentId: AGENT_ID,
      profile: SKW_PROFILE,
      sessionId: "sid",
      sessionKey: "skey",
    });
  });

  it("preserves idempotent memoryWrite request shape across repeated calls", async () => {
    const { manager, stdout, stdin } = await createManager();

    const first = manager.memoryWrite({
      eventId: "evt-repeat",
      target: "user",
      content: "repeatable note",
      metadata: { category: "user_pref" },
    });
    const firstFrame = await respondToOperation(stdout, stdin, "memoryWrite", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { search: true } });
    await first;

    const second = manager.memoryWrite({
      eventId: "evt-repeat",
      target: "user",
      content: "repeatable note",
      metadata: { category: "user_pref" },
    });
    const secondFrame = await respondToOperation(stdout, stdin, "memoryWrite", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { search: true } });
    await second;

    expect(secondFrame.params).toEqual(firstFrame.params);
    expect(secondFrame.identity).toEqual(firstFrame.identity);
  });

  it("sends agentEnd with eventId, success, messages, and durationMs", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.agentEnd({
      eventId: "ae-1",
      success: true,
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
      ],
      durationMs: 1000,
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "agentEnd", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { embedding: true } });
    await promise;

    expect(frame).toMatchObject({
      version: 1,
      op: "agentEnd",
      identity: { agentId: AGENT_ID, profile: SKW_PROFILE, sessionId: "sid", sessionKey: "skey" },
    });
    expect(frame.params).toEqual({
      eventId: "ae-1",
      success: true,
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
      ],
      durationMs: 1000,
    });
  });

  it("sends agentEnd without durationMs when omitted", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.agentEnd({
      eventId: "ae-2",
      success: false,
      messages: [],
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "agentEnd", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { embedding: true } });
    await promise;

    expect(frame.params).toEqual({
      eventId: "ae-2",
      success: false,
      messages: [],
    });
  });

  it("sends prepareCompaction with compactionId, messages, and maxCharacters", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.prepareCompaction({
      compactionId: "pc-1",
      messages: [{ role: "user", text: "hello" }],
      maxCharacters: 4096,
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "prepareCompaction", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { compaction: true } });
    await promise;

    expect(frame).toMatchObject({
      version: 1,
      op: "prepareCompaction",
      identity: { agentId: AGENT_ID, profile: SKW_PROFILE, sessionId: "sid", sessionKey: "skey" },
    });
    expect(frame.params).toEqual({
      compactionId: "pc-1",
      messages: [{ role: "user", text: "hello" }],
      maxCharacters: 4096,
    });
  });

  it("defaults prepareCompaction maxCharacters to 8192", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.prepareCompaction({
      compactionId: "pc-2",
      messages: [],
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "prepareCompaction", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { compaction: true } });
    await promise;

    expect(frame.params).toEqual({
      compactionId: "pc-2",
      messages: [],
      maxCharacters: 8192,
    });
  });

  it("sends finishCompaction with compactionId, outcome, and compactedCount", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.finishCompaction({
      compactionId: "fc-1",
      outcome: "success",
      compactedCount: 42,
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "finishCompaction", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { compaction: true } });
    await promise;

    expect(frame).toMatchObject({
      version: 1,
      op: "finishCompaction",
      identity: { agentId: AGENT_ID, profile: SKW_PROFILE, sessionId: "sid", sessionKey: "skey" },
    });
    expect(frame.params).toEqual({
      compactionId: "fc-1",
      outcome: "success",
      compactedCount: 42,
    });
  });

  it("omits compactedCount on failed finishCompaction", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.finishCompaction({
      compactionId: "fc-2",
      outcome: "failed",
      compactedCount: 5,
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "finishCompaction", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { compaction: true } });
    await promise;

    expect(frame.params).toEqual({
      compactionId: "fc-2",
      outcome: "failed",
    });
  });

  it("sends endSession with reason, nextSessionId, and nextSessionKey", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.endSession({
      reason: "archive",
      nextSessionId: "next-sid",
      nextSessionKey: "next-skey",
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "endSession", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { embedding: true } });
    await promise;

    expect(frame).toMatchObject({
      version: 1,
      op: "endSession",
      identity: { agentId: AGENT_ID, profile: SKW_PROFILE, sessionId: "sid", sessionKey: "skey" },
    });
    expect(frame.params).toEqual({
      reason: "archive",
      nextSessionId: "next-sid",
      nextSessionKey: "next-skey",
    });
  });

  it("sends endSession with only reason when successors are absent", async () => {
    const { manager, stdout, stdin } = await createManager();
    const promise = manager.endSession({
      reason: "shutdown",
      sessionId: "sid",
      sessionKey: "skey",
    });
    const frame = await respondToOperation(stdout, stdin, "endSession", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { embedding: true } });
    await promise;

    expect(frame.params).toEqual({ reason: "shutdown" });
  });

  it("rejects memoryWrite when the provider returns a non-object result", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.memoryWrite({
      eventId: "evt-3",
      target: "user",
      content: "x",
    });
    const frame = await waitForOperationFrame(stdin, "memoryWrite");
    emitFrame(stdout, { version: 1, id: frame.id, ok: true, result: "unexpected" });

    await expect(promise).rejects.toMatchObject({
      code: "MALFORMED_OUTPUT",
    } satisfies Partial<SkwProviderError>);
  });

  it("rejects lifecycle methods when the provider returns a non-object result", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.agentEnd({
      eventId: "ae",
      success: true,
      messages: [],
    });
    const frame = await waitForOperationFrame(stdin, "agentEnd");
    emitFrame(stdout, { version: 1, id: frame.id, ok: true, result: 123 });

    await expect(promise).rejects.toMatchObject({
      code: "MALFORMED_OUTPUT",
    } satisfies Partial<SkwProviderError>);
  });

  it("refreshes status after successful lifecycle operation", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.endSession({ reason: "shutdown" });
    await respondToOperation(stdout, stdin, "endSession", {});
    await respondToOperation(stdout, stdin, "status", {
      capabilities: { embedding: true, vector: true },
      available: true,
    });
    await promise;

    expect(manager.status().vector?.available).toBe(true);
  });

  it("propagates provider errors from lifecycle requests", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.prepareCompaction({
      compactionId: "pc-err",
      messages: [],
    });
    const frame = await waitForOperationFrame(stdin, "prepareCompaction");
    emitFrame(stdout, {
      version: 1,
      id: frame.id,
      ok: false,
      error: { code: "UNAVAILABLE", message: "compaction offline", retryable: true },
    });

    await expect(promise).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    } satisfies Partial<SkwProviderError>);
  });

  it("exposes lifecycle methods regardless of the writable profile flag", async () => {
    const { manager, stdout, stdin } = await createManager({
      profileDefinition: { limits: { writable: false } },
    });

    const promise = manager.memoryWrite({
      eventId: "evt",
      target: "general",
      content: "x",
    });
    await respondToOperation(stdout, stdin, "memoryWrite", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { search: true } });
    await promise;

    expect(manager.status().vector?.enabled).toBe(false);
  });

  it("captures lifecycle frames for the shared validator probe", async () => {
    const { manager, stdout, stdin } = await createManager();
    const captured: Record<string, unknown>[] = [];

    async function captureOp(op: string, call: () => Promise<void>) {
      const promise = call();
      const frame = await respondToOperation(stdout, stdin, op, {});
      await respondToOperation(stdout, stdin, "status", { capabilities: { search: true } });
      await promise;
      captured.push(frame);
    }

    await captureOp("memoryWrite", () =>
      manager.memoryWrite({
        eventId: "evt-probe",
        target: "user",
        content: "hello world",
        metadata: { category: "user_pref" },
        sessionId: "sid-probe",
        sessionKey: "skey-probe",
      }),
    );

    await captureOp("agentEnd", () =>
      manager.agentEnd({
        eventId: "ae-probe",
        success: true,
        messages: [
          { role: "user", text: "hello" },
          { role: "assistant", text: "hi" },
        ],
        durationMs: 1234,
        sessionId: "sid-probe",
        sessionKey: "skey-probe",
      }),
    );

    await captureOp("prepareCompaction", () =>
      manager.prepareCompaction({
        compactionId: "pc-probe",
        messages: [{ role: "user", text: "hello" }],
        maxCharacters: 4096,
        sessionId: "sid-probe",
        sessionKey: "skey-probe",
      }),
    );

    await captureOp("finishCompaction", () =>
      manager.finishCompaction({
        compactionId: "fc-probe",
        outcome: "success",
        compactedCount: 42,
        sessionId: "sid-probe",
        sessionKey: "skey-probe",
      }),
    );

    await captureOp("endSession", () =>
      manager.endSession({
        reason: "archive",
        nextSessionId: "next-sid-probe",
        nextSessionKey: "next-skey-probe",
        sessionId: "sid-probe",
        sessionKey: "skey-probe",
      }),
    );

    const ndjson = captured.map((frame) => JSON.stringify(frame)).join("\n");
    writeFileSync("/tmp/opencode/todo10-captured-frames.ndjson", ndjson + "\n");
    expect(captured).toHaveLength(5);
  });
});
