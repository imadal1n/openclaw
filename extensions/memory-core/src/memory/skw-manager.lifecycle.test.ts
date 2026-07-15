// Tests for SKW memory manager lifecycle methods.
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

  it("sends memoryWrite with eventId, content, and metadata category", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.memoryWrite({
      eventId: "evt-1",
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
      content: "hello world",
      metadata: { category: "user_pref" },
    });
  });

  it("binds sessionId and sessionKey to memoryWrite identity", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.memoryWrite({
      eventId: "evt-2",
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
      content: "repeatable note",
      metadata: { category: "user_pref" },
    });
    const firstFrame = await respondToOperation(stdout, stdin, "memoryWrite", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { search: true } });
    await first;

    const second = manager.memoryWrite({
      eventId: "evt-repeat",
      content: "repeatable note",
      metadata: { category: "user_pref" },
    });
    const secondFrame = await respondToOperation(stdout, stdin, "memoryWrite", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { search: true } });
    await second;

    expect(secondFrame.params).toEqual(firstFrame.params);
    expect(secondFrame.identity).toEqual(firstFrame.identity);
  });

  it.each([
    ["agentEnd", {}],
    ["prepareCompaction", {}],
    ["finishCompaction", {}],
    ["endSession", {}],
  ] as const)("sends %s with empty params and identity", async (op, result) => {
    const { manager, stdout, stdin } = await createManager();
    const lifecycleMethods = {
      agentEnd: (p: { sessionId?: string; sessionKey?: string }) => manager.agentEnd(p),
      prepareCompaction: (p: { sessionId?: string; sessionKey?: string }) =>
        manager.prepareCompaction(p),
      finishCompaction: (p: { sessionId?: string; sessionKey?: string }) =>
        manager.finishCompaction(p),
      endSession: (p: { sessionId?: string; sessionKey?: string }) => manager.endSession(p),
    };

    const promise = lifecycleMethods[op]({ sessionId: "sid", sessionKey: "skey" });
    const frame = await respondToOperation(stdout, stdin, op, result);
    await respondToOperation(stdout, stdin, "status", {
      capabilities: { embedding: true, vector: true },
    });
    await promise;

    expect(frame).toMatchObject({
      version: 1,
      op,
      identity: { agentId: AGENT_ID, profile: SKW_PROFILE, sessionId: "sid", sessionKey: "skey" },
      params: {},
    });
  });

  it("rejects memoryWrite when the provider returns a non-object result", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.memoryWrite({ eventId: "evt-3", content: "x" });
    const frame = await waitForOperationFrame(stdin, "memoryWrite");
    emitFrame(stdout, { version: 1, id: frame.id, ok: true, result: "unexpected" });

    await expect(promise).rejects.toMatchObject({
      code: "MALFORMED_OUTPUT",
    } satisfies Partial<SkwProviderError>);
  });

  it("rejects lifecycle methods when the provider returns a non-object result", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.agentEnd({});
    const frame = await waitForOperationFrame(stdin, "agentEnd");
    emitFrame(stdout, { version: 1, id: frame.id, ok: true, result: 123 });

    await expect(promise).rejects.toMatchObject({
      code: "MALFORMED_OUTPUT",
    } satisfies Partial<SkwProviderError>);
  });

  it("refreshes status after successful lifecycle operation", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.endSession({});
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

    const promise = manager.prepareCompaction({});
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

    const promise = manager.memoryWrite({ eventId: "evt", content: "x" });
    await respondToOperation(stdout, stdin, "memoryWrite", {});
    await respondToOperation(stdout, stdin, "status", { capabilities: { search: true } });
    await promise;

    expect(manager.status().vector?.enabled).toBe(false);
  });
});
