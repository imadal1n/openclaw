/* oxlint-disable typescript/unbound-method -- vitest mocks of MemorySearchManager lifecycle methods; not unbound class methods. */
import type {
  MemoryMessage,
  MemorySearchManager,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionEndContext,
  mapSessionEndReason,
  normalizeMessages,
  resolveAgentEndEventId,
} from "./skw-lifecycle-hooks.helpers.js";
import {
  handleSkwAfterCompaction,
  handleSkwAgentEnd,
  handleSkwBeforeCompaction,
  handleSkwSessionEnd,
  type SkwLifecycleHookRuntime,
} from "./skw-lifecycle-hooks.js";

const UUID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const AGENT_CTX = { agentId: "main", sessionId: "session-1", sessionKey: "agent:main:session-1" };

function createMockManager(overrides: Partial<MemorySearchManager> = {}): MemorySearchManager {
  return {
    search: vi.fn(),
    readFile: vi.fn(),
    status: vi.fn(),
    probeEmbeddingAvailability: vi.fn(),
    probeVectorAvailability: vi.fn(),
    agentEnd: vi.fn(),
    endSession: vi.fn(),
    prepareCompaction: vi.fn(),
    finishCompaction: vi.fn(),
    ...overrides,
  } as unknown as MemorySearchManager;
}

function createMockRuntime(manager: MemorySearchManager): SkwLifecycleHookRuntime {
  return { getMemorySearchManager: vi.fn().mockResolvedValue({ manager }) };
}

const createMockConfig = () => ({ memory: { backend: "skw" } }) as never;

const messages = [
  { role: "system", content: "system" },
  { role: "user", content: "hello" },
  { role: "assistant", content: [{ type: "text", text: "hi" }] },
];

const expectedMessages: MemoryMessage[] = [
  { role: "user", text: "hello" },
  { role: "assistant", text: "hi" },
];

describe("handleSkwAgentEnd", () => {
  it("sends eventId, success, normalized messages, and duration on success", async () => {
    const manager = createMockManager();
    await handleSkwAgentEnd({
      event: { runId: UUID, messages, success: true, durationMs: 1234 },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    const call = vi.mocked(manager.agentEnd!).mock.calls[0][0];
    expect(call).toEqual({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      eventId: UUID,
      success: true,
      messages: expectedMessages,
      durationMs: 1234,
    });
  });

  it("omits durationMs when not provided", async () => {
    const manager = createMockManager();
    await handleSkwAgentEnd({
      event: { runId: UUID, messages: [], success: true },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    const call = vi.mocked(manager.agentEnd!).mock.calls[0][0];
    expect(call.durationMs).toBeUndefined();
  });

  it("omits durationMs when non-finite", async () => {
    const manager = createMockManager();
    await handleSkwAgentEnd({
      event: { runId: UUID, messages: [], success: true, durationMs: Number.NaN },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    const call = vi.mocked(manager.agentEnd!).mock.calls[0][0];
    expect(call.durationMs).toBeUndefined();
  });

  it("sends an empty messages array when no messages are provided", async () => {
    const manager = createMockManager();
    await handleSkwAgentEnd({
      event: { runId: UUID, messages: [], success: true },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    const call = vi.mocked(manager.agentEnd!).mock.calls[0][0];
    expect(call.messages).toEqual([]);
  });

  it("uses a stable eventId when runId is not a UUID", async () => {
    const manager = createMockManager();
    const event: PluginHookAgentEndEvent = {
      runId: "run-1",
      messages: [{ role: "user", content: "hi" }],
      success: true,
    };
    const runtime = createMockRuntime(manager);
    await handleSkwAgentEnd({ event, ctx: AGENT_CTX, runtime, getConfig: createMockConfig });
    const first = vi.mocked(manager.agentEnd!).mock.calls[0][0].eventId;
    await handleSkwAgentEnd({ event, ctx: AGENT_CTX, runtime, getConfig: createMockConfig });
    expect(vi.mocked(manager.agentEnd!).mock.calls[1][0].eventId).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("skips when success is false", async () => {
    const manager = createMockManager();
    await handleSkwAgentEnd({
      event: { messages: [], success: false } as PluginHookAgentEndEvent,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    expect(manager.agentEnd).not.toHaveBeenCalled();
  });

  it("skips when agentId is missing", async () => {
    const manager = createMockManager();
    await handleSkwAgentEnd({
      event: { runId: UUID, messages: [], success: true },
      ctx: { sessionId: "session-1" } as PluginHookAgentContext,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    expect(manager.agentEnd).not.toHaveBeenCalled();
  });

  it("skips when manager lacks agentEnd", async () => {
    const manager = createMockManager({ agentEnd: undefined });
    await handleSkwAgentEnd({
      event: { runId: UUID, messages: [], success: true },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    expect(manager.agentEnd).toBeUndefined();
  });

  it("logs when manager.agentEnd rejects", async () => {
    const manager = createMockManager({ agentEnd: vi.fn().mockRejectedValue(new Error("boom")) });
    const logs: string[] = [];
    await handleSkwAgentEnd({
      event: { runId: UUID, messages: [], success: true },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      log: (message) => logs.push(message),
    });
    expect(manager.agentEnd).toHaveBeenCalledOnce();
    expect(logs.some((message) => message.includes("agentEnd failed"))).toBe(true);
  });

  it("does not mutate the original messages", async () => {
    const manager = createMockManager();
    const event: PluginHookAgentEndEvent = { runId: UUID, messages, success: true };
    await handleSkwAgentEnd({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    expect(messages[1].role).toBe("user");
    expect((messages[2] as { content: unknown }).content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("handleSkwSessionEnd", () => {
  it("sends reason and successor identity without eventId", async () => {
    const manager = createMockManager();
    const event: PluginHookSessionEndEvent = {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      messageCount: 5,
      reason: "compaction" as PluginHookSessionEndReason,
      nextSessionId: "session-2",
      nextSessionKey: "agent:main:session-2",
    };
    await handleSkwSessionEnd({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    const call = vi.mocked(manager.endSession!).mock.calls[0][0];
    expect(call).toEqual({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      reason: "archive",
      nextSessionId: "session-2",
      nextSessionKey: "agent:main:session-2",
    });
    expect((call as { eventId?: unknown }).eventId).toBeUndefined();
  });

  it("skips when agentId is missing", async () => {
    const manager = createMockManager();
    const event: PluginHookSessionEndEvent = { sessionId: "session-1", messageCount: 0 };
    await handleSkwSessionEnd({
      event,
      ctx: { sessionId: "session-1" } as PluginHookSessionContext,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
    });
    expect(manager.endSession).not.toHaveBeenCalled();
  });

  it("logs when manager.endSession rejects", async () => {
    const manager = createMockManager({
      endSession: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const logs: string[] = [];
    await handleSkwSessionEnd({
      event: { sessionId: "session-1", messageCount: 0 },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      log: (message) => logs.push(message),
    });
    expect(manager.endSession).toHaveBeenCalledOnce();
    expect(logs.some((message) => message.includes("endSession failed"))).toBe(true);
  });
});

describe("handleSkwBeforeCompaction", () => {
  it("sends compactionId, normalized messages, and default maxCharacters", async () => {
    const manager = createMockManager();
    const event: PluginHookBeforeCompactionEvent = {
      messageCount: 2,
      messages: [{ role: "user", content: "hello" }],
    };
    await handleSkwBeforeCompaction({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
    });
    const call = vi.mocked(manager.prepareCompaction!).mock.calls[0][0];
    expect(call).toEqual({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      compactionId: UUID,
      messages: [{ role: "user", text: "hello" }],
      maxCharacters: 8192,
    });
  });

  it("uses maxCharacters from the event when provided", async () => {
    const manager = createMockManager();
    const event: PluginHookBeforeCompactionEvent = {
      messageCount: 2,
      messages: [{ role: "user", content: "hello" }],
      maxCharacters: 4096,
    };
    await handleSkwBeforeCompaction({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
    });
    const call = vi.mocked(manager.prepareCompaction!).mock.calls[0][0];
    expect(call.maxCharacters).toBe(4096);
  });

  it("sends an empty messages array when none are provided", async () => {
    const manager = createMockManager();
    const event: PluginHookBeforeCompactionEvent = { messageCount: 0 };
    await handleSkwBeforeCompaction({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
    });
    const call = vi.mocked(manager.prepareCompaction!).mock.calls[0][0];
    expect(call.messages).toEqual([]);
  });

  it("skips when agentId is missing", async () => {
    const manager = createMockManager();
    const event: PluginHookBeforeCompactionEvent = { messageCount: 10 };
    await handleSkwBeforeCompaction({
      event,
      ctx: { sessionId: "session-1" } as PluginHookAgentContext,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
    });
    expect(manager.prepareCompaction).not.toHaveBeenCalled();
  });

  it("logs when manager.prepareCompaction rejects", async () => {
    const manager = createMockManager({
      prepareCompaction: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const logs: string[] = [];
    await handleSkwBeforeCompaction({
      event: { messageCount: 1, messages: [{ role: "user", content: "x" }] },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
      log: (message) => logs.push(message),
    });
    expect(manager.prepareCompaction).toHaveBeenCalledOnce();
    expect(logs.some((message) => message.includes("prepareCompaction failed"))).toBe(true);
  });
});

describe("handleSkwAfterCompaction", () => {
  it("sends compactionId, outcome success, and compactedCount", async () => {
    const manager = createMockManager();
    const event: PluginHookAfterCompactionEvent = { messageCount: 1, compactedCount: 5 };
    await handleSkwAfterCompaction({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
      outcome: "success",
      compactedCount: 5,
    });
    expect(manager.finishCompaction).toHaveBeenCalledOnce();
    const call = vi.mocked(manager.finishCompaction!).mock.calls[0][0];
    expect(call).toEqual({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      compactionId: UUID,
      outcome: "success",
      compactedCount: 5,
    });
  });

  it("omits compactedCount when outcome is failed", async () => {
    const manager = createMockManager();
    const event: PluginHookAfterCompactionEvent = { messageCount: 10, compactedCount: 0 };
    await handleSkwAfterCompaction({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: "compaction-456",
      outcome: "failed",
      compactedCount: 5,
    });
    const call = vi.mocked(manager.finishCompaction!).mock.calls[0][0];
    expect(call.outcome).toBe("failed");
    expect(call.compactedCount).toBeUndefined();
  });

  it("omits compactedCount when success but count is not a number", async () => {
    const manager = createMockManager();
    const event: PluginHookAfterCompactionEvent = { messageCount: 10, compactedCount: 0 };
    await handleSkwAfterCompaction({
      event,
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: "compaction-789",
      outcome: "success",
      compactedCount: undefined,
    });
    const call = vi.mocked(manager.finishCompaction!).mock.calls[0][0];
    expect(call.outcome).toBe("success");
    expect(call.compactedCount).toBeUndefined();
  });

  it("skips when agentId is missing", async () => {
    const manager = createMockManager();
    await handleSkwAfterCompaction({
      event: { messageCount: 5, compactedCount: 5 },
      ctx: { sessionId: "session-1" } as PluginHookAgentContext,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
      outcome: "success",
      compactedCount: 5,
    });
    expect(manager.finishCompaction).not.toHaveBeenCalled();
  });

  it("skips when compactionId is empty", async () => {
    const manager = createMockManager();
    const logs: string[] = [];
    await handleSkwAfterCompaction({
      event: { messageCount: 5, compactedCount: 5 },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: "",
      outcome: "success",
      compactedCount: 5,
      log: (message) => logs.push(message),
    });
    expect(manager.finishCompaction).not.toHaveBeenCalled();
    expect(logs.some((message) => message.includes("no compactionId"))).toBe(true);
  });

  it("skips when manager lacks finishCompaction", async () => {
    const manager = createMockManager({ finishCompaction: undefined });
    await handleSkwAfterCompaction({
      event: { messageCount: 5, compactedCount: 5 },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
      outcome: "success",
      compactedCount: 5,
    });
    expect(manager.finishCompaction).toBeUndefined();
  });

  it("logs when manager.finishCompaction rejects", async () => {
    const manager = createMockManager({
      finishCompaction: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const logs: string[] = [];
    await handleSkwAfterCompaction({
      event: { messageCount: 5, compactedCount: 5 },
      ctx: AGENT_CTX,
      runtime: createMockRuntime(manager),
      getConfig: createMockConfig,
      compactionId: UUID,
      outcome: "success",
      compactedCount: 5,
      log: (message) => logs.push(message),
    });
    expect(manager.finishCompaction).toHaveBeenCalledOnce();
    expect(logs.some((message) => message.includes("finishCompaction failed"))).toBe(true);
  });
});

describe("helpers", () => {
  it("resolveAgentEndEventId returns the runId when it is a UUID", () => {
    expect(resolveAgentEndEventId({ runId: UUID })).toBe(UUID);
  });

  it("resolveAgentEndEventId returns a stable deterministic UUID from a non-UUID seed", () => {
    const id = resolveAgentEndEventId({ runId: "run-1", sessionId: "session-1" });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(resolveAgentEndEventId({ runId: "run-1", sessionId: "session-1" })).toBe(id);
  });

  it.each([
    ["compaction", "archive"],
    ["deleted", "archive"],
    ["shutdown", "shutdown"],
    ["restart", "shutdown"],
    ["new", "new"],
    ["reset", "reset"],
    ["idle", "other"],
  ])("mapSessionEndReason maps %s to %s", (input, expected) => {
    expect(mapSessionEndReason(input as PluginHookSessionEndReason)).toBe(expected);
  });

  it("normalizeMessages skips system and empty content", () => {
    expect(normalizeMessages(messages)).toEqual(expectedMessages);
  });

  it("buildSessionEndContext omits eventId and maps reason", () => {
    const context = buildSessionEndContext({
      event: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        reason: "restart",
        nextSessionId: "session-2",
      },
    });
    expect(context).toEqual({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      reason: "shutdown",
      nextSessionId: "session-2",
    });
    expect((context as { eventId?: unknown }).eventId).toBeUndefined();
  });
});
