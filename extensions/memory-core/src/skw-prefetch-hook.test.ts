import type {
  MemoryPrefetchQuality,
  MemorySearchManager,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type {
  MemoryPluginRuntime,
  MemoryRuntimeCapability,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
} from "openclaw/plugin-sdk/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSkwPrefetchResult } from "./memory/skw-prefetch.js";
import { buildSkwPrefetchHookResult } from "./skw-prefetch-hook.js";

function getConfig(): OpenClawConfig {
  return {} as unknown as OpenClawConfig;
}

function createMockRuntime(overrides: {
  backend?: "skw" | "qmd" | "builtin";
  prefetchEnabled?: boolean;
  manager?: MemorySearchManager | null;
}): MemoryPluginRuntime {
  return {
    getMemorySearchManager: vi.fn(async () => ({ manager: overrides.manager ?? null })),
    resolveMemoryBackendConfig: vi.fn(() => ({
      backend: overrides.backend ?? "skw",
      citations: "auto" as const,
      skw:
        overrides.backend === "skw"
          ? {
              effective: {
                writable: false,
                autoExtract: false,
                prefetch: overrides.prefetchEnabled ?? true,
              },
            }
          : undefined,
    })),
    getMemoryRuntimeStatus: vi.fn(),
    probeMemoryRuntime: vi.fn(),
    getMemoryRuntimeCapabilities: vi.fn(() => {
      const backend = overrides.backend ?? "skw";
      const features = new Set<MemoryRuntimeCapability>(["search", "get"]);
      const prefetch = backend === "skw" && (overrides.prefetchEnabled ?? true);
      if (prefetch) {
        features.add("prefetch");
      }
      return {
        backend,
        features,
        writable: false,
        autoExtract: false,
        prefetch,
      };
    }),
  } as MemoryPluginRuntime;
}

function createMockManager(prefetch?: MemorySearchManager["prefetch"]): MemorySearchManager {
  return {
    search: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ text: "", path: "" })),
    status: vi.fn(() => ({ backend: "skw" as const, provider: "skw" })),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => true),
    prefetch,
  } as MemorySearchManager;
}

function createMockEvent(messages: unknown[] = []): PluginHookBeforePromptBuildEvent {
  return { prompt: "hello", messages };
}

function createMockCtx(overrides: Partial<PluginHookAgentContext> = {}): PluginHookAgentContext {
  return {
    agentId: "agent",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    ...overrides,
  };
}

function createSharedFixture(
  quality: MemoryPrefetchQuality,
  context: string,
  systemPromptBlock?: string,
) {
  return {
    context,
    quality,
    cacheKeyHash: `hash-${quality}`,
    queued: quality === "fast",
    ...(systemPromptBlock ? { systemPromptBlock } : {}),
  };
}

describe("parseSkwPrefetchResult", () => {
  it("accepts actual shared fast JSON sample", () => {
    expect(
      parseSkwPrefetchResult({
        context: "fast recall",
        quality: "fast",
        cacheKeyHash: "abc123",
        queued: true,
      }),
    ).toEqual({
      context: "fast recall",
      quality: "fast",
    });
  });

  it("accepts actual shared cached-full JSON sample", () => {
    expect(
      parseSkwPrefetchResult({
        context: "full cached recall",
        quality: "cached-full",
        cacheKeyHash: "def456",
        queued: false,
        systemPromptBlock: "static guidance",
      }),
    ).toEqual({
      context: "full cached recall",
      quality: "cached-full",
      systemPromptBlock: "static guidance",
    });
  });

  it("accepts actual shared abstain JSON sample", () => {
    expect(
      parseSkwPrefetchResult({
        context: "",
        quality: "abstain",
        cacheKeyHash: "ghi789",
        queued: false,
      }),
    ).toEqual({
      context: "",
      quality: "abstain",
    });
  });

  it("rejects numeric quality", () => {
    expect(() =>
      parseSkwPrefetchResult({
        context: "x",
        quality: 0.5,
        cacheKeyHash: "h",
        queued: false,
      }),
    ).toThrow(/quality must be one of/);
  });

  it("rejects unknown string quality", () => {
    expect(() =>
      parseSkwPrefetchResult({
        context: "x",
        quality: "high",
        cacheKeyHash: "h",
        queued: false,
      }),
    ).toThrow(/quality must be one of/);
  });
});

describe("buildSkwPrefetchHookResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects fast recall on first turn and cached-full recall on second turn", async () => {
    const prefetch = vi
      .fn()
      .mockResolvedValueOnce(createSharedFixture("fast", "fast context"))
      .mockResolvedValueOnce(
        createSharedFixture("cached-full", "full cached context", "static guidance"),
      );
    const manager = createMockManager(prefetch);
    const runtime = createMockRuntime({ manager });
    const ctx = createMockCtx();

    const first = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx,
      runtime,
      getConfig,
    });
    const second = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx,
      runtime,
      getConfig,
    });

    expect(first).toEqual({ prependContext: "fast context" });
    expect(second).toEqual({
      prependContext: "full cached context",
      appendSystemContext: "static guidance",
    });
    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenLastCalledWith({
      query: "hello",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
    });
  });

  it("abstain returns static guidance but no dynamic context", async () => {
    const prefetch = vi.fn().mockResolvedValue({
      context: "should be ignored",
      quality: "abstain",
      cacheKeyHash: "hash-abstain",
      queued: false,
      systemPromptBlock: "static guidance",
    });
    const manager = createMockManager(prefetch);
    const runtime = createMockRuntime({ manager });

    const result = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx(),
      runtime,
      getConfig,
    });

    expect(result).toEqual({ appendSystemContext: "static guidance" });
  });

  it("injects nothing when any identity field is missing", async () => {
    const manager = createMockManager(vi.fn());
    const runtime = createMockRuntime({ manager });

    const missingAgentId = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx({ agentId: undefined }),
      runtime,
      getConfig,
    });
    const missingSessionId = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx({ sessionId: undefined }),
      runtime,
      getConfig,
    });
    const missingSessionKey = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx({ sessionKey: undefined }),
      runtime,
      getConfig,
    });

    expect(missingAgentId).toEqual({});
    expect(missingSessionId).toEqual({});
    expect(missingSessionKey).toEqual({});
    expect(runtime.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("leaves QMD and builtin callers unchanged", async () => {
    const manager = createMockManager(vi.fn());
    const qmdRuntime = createMockRuntime({ backend: "qmd", manager });
    const builtinRuntime = createMockRuntime({ backend: "builtin", manager });
    const ctx = createMockCtx();

    const qmdResult = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx,
      runtime: qmdRuntime,
      getConfig,
    });
    const builtinResult = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx,
      runtime: builtinRuntime,
      getConfig,
    });

    expect(qmdResult).toEqual({});
    expect(builtinResult).toEqual({});
    expect(qmdRuntime.getMemorySearchManager).not.toHaveBeenCalled();
    expect(builtinRuntime.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("abstains when prefetch is not enabled", async () => {
    const manager = createMockManager(vi.fn());
    const runtime = createMockRuntime({ backend: "skw", prefetchEnabled: false, manager });

    const result = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx(),
      runtime,
      getConfig,
    });

    expect(result).toEqual({});
    expect(runtime.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("abstains when manager has no prefetch implementation", async () => {
    const manager = createMockManager(undefined);
    const runtime = createMockRuntime({ manager });

    const result = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx(),
      runtime,
      getConfig,
    });

    expect(result).toEqual({});
    expect(runtime.getMemorySearchManager).toHaveBeenCalledOnce();
  });

  it("abstains on prefetch error or malformed response", async () => {
    const errorPrefetch = vi.fn().mockRejectedValue(new Error("provider failed"));
    const errorManager = createMockManager(errorPrefetch);
    const errorRuntime = createMockRuntime({ manager: errorManager });

    const errorResult = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx(),
      runtime: errorRuntime,
      getConfig,
    });

    expect(errorResult).toEqual({});

    const malformedPrefetch = vi.fn().mockResolvedValue({
      context: 123,
      quality: "high",
      cacheKeyHash: 456,
      queued: "yes",
    });
    const malformedManager = createMockManager(malformedPrefetch);
    const malformedRuntime = createMockRuntime({ manager: malformedManager });

    const malformedResult = await buildSkwPrefetchHookResult({
      event: createMockEvent(),
      ctx: createMockCtx(),
      runtime: malformedRuntime,
      getConfig,
    });

    expect(malformedResult).toEqual({});
  });

  it("does not mutate event.messages", async () => {
    const prefetch = vi.fn().mockResolvedValue({
      context: "recall",
      quality: "cached-full",
      systemPromptBlock: "guidance",
      cacheKeyHash: "hash",
      queued: false,
    });
    const manager = createMockManager(prefetch);
    const runtime = createMockRuntime({ manager });
    const messages = [{ role: "user" as const, content: "hi" }];
    const event = createMockEvent(messages);
    const messagesBefore = JSON.stringify(event.messages);

    await buildSkwPrefetchHookResult({
      event,
      ctx: createMockCtx(),
      runtime,
      getConfig,
    });

    expect(JSON.stringify(event.messages)).toBe(messagesBefore);
    expect(event.messages).toBe(messages);
  });
});
