// Tests for the memory-core runtime provider lifecycle methods.
import type {
  MemoryPluginRuntime,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { memoryRuntime } from "./runtime-provider.js";

function registerMemoryCoreRuntime(): MemoryPluginRuntime {
  let runtime: MemoryPluginRuntime | undefined;
  plugin.register(
    createTestPluginApi({
      registerMemoryCapability(capability) {
        runtime = capability.runtime;
      },
    }),
  );
  if (!runtime) {
    throw new Error("expected memory-core to register a memory runtime");
  }
  return runtime;
}

describe("memory runtime lifecycle", () => {
  it("exports getMemoryRuntimeStatus", () => {
    expect(memoryRuntime.getMemoryRuntimeStatus).toBeTypeOf("function");
  });

  it("exports probeMemoryRuntime", () => {
    expect(memoryRuntime.probeMemoryRuntime).toBeTypeOf("function");
  });

  it("exports getMemoryRuntimeCapabilities", () => {
    expect(memoryRuntime.getMemoryRuntimeCapabilities).toBeTypeOf("function");
  });

  it("returns cached status for builtin backend", () => {
    const cfg = { memory: { backend: "builtin" } } as OpenClawConfig;
    const status = memoryRuntime.getMemoryRuntimeStatus({ cfg, agentId: "main" });
    expect(status.backend).toBe("builtin");
    expect(status.ready).toBe(true);
    expect(status.profile).toBeUndefined();
  });

  it("returns capabilities for builtin backend", () => {
    const cfg = { memory: { backend: "builtin" } } as OpenClawConfig;
    const caps = memoryRuntime.getMemoryRuntimeCapabilities({ cfg, agentId: "main" });
    expect(caps.backend).toBe("builtin");
    expect(caps.features.has("search")).toBe(true);
    expect(caps.features.has("get")).toBe(true);
    expect(caps.writable).toBe(false);
  });

  it("returns capabilities for skw backend from effective policy", () => {
    const cfg = {
      memory: {
        backend: "skw",
        agents: {
          main: { backend: "skw", skw: { profile: "main-profile", writable: true } },
        },
        skw: {
          profileDefinitions: {
            "main-profile": {
              databasePath: "/nix/db.sqlite",
              memoryDatabasePath: "/nix/memory.sqlite",
              sessionMapPath: "/nix/session.json",
              cachePath: "/nix/cache",
              allowedCollections: [],
              allowedSourceRoots: [],
              limits: {
                recallMode: "hybrid",
                topK: 10,
                writable: true,
                autoExtract: true,
                extractor: "llm",
                maxWriteCharacters: 1000,
                maxInjectedCharacters: 2000,
                maxInjectedTokens: 500,
                minTurnsBetweenAttempts: 1,
                candidatePoolSize: 20,
                rerankThreshold: 0.5,
                maxChunksPerSource: 3,
                defaultTrust: 0.8,
                minTrust: 0.2,
                temporalDecayHalfLife: 24,
                rerankerModel: "default",
                rerankerCacheDir: "/tmp",
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const caps = memoryRuntime.getMemoryRuntimeCapabilities({ cfg, agentId: "main" });
    expect(caps.backend).toBe("skw");
    expect(caps.writable).toBe(true);
    expect(caps.features.has("write")).toBe(true);
  });

  it("probes builtin backend successfully", async () => {
    const cfg = { memory: { backend: "builtin" } } as OpenClawConfig;
    const result = await memoryRuntime.probeMemoryRuntime({ cfg, agentId: "main" });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not bleed cached status across different configs for the same agent", () => {
    const skwCfg = {
      memory: {
        backend: "skw",
        agents: {
          main: { backend: "skw", skw: { profile: "main-profile" } },
        },
        skw: {
          profileDefinitions: {
            "main-profile": {
              databasePath: "/nix/db.sqlite",
              memoryDatabasePath: "/nix/memory.sqlite",
              sessionMapPath: "/nix/session.json",
              cachePath: "/nix/cache",
              allowedCollections: [],
              allowedSourceRoots: [],
              limits: {
                recallMode: "hybrid",
                topK: 10,
                writable: true,
                autoExtract: true,
                extractor: "llm",
                maxWriteCharacters: 1000,
                maxInjectedCharacters: 2000,
                maxInjectedTokens: 500,
                minTurnsBetweenAttempts: 1,
                candidatePoolSize: 20,
                rerankThreshold: 0.5,
                maxChunksPerSource: 3,
                defaultTrust: 0.8,
                minTrust: 0.2,
                temporalDecayHalfLife: 24,
                rerankerModel: "default",
                rerankerCacheDir: "/tmp",
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const builtinCfg = { memory: { backend: "builtin" } } as OpenClawConfig;

    const first = memoryRuntime.getMemoryRuntimeStatus({ cfg: skwCfg, agentId: "main" });
    expect(first.backend).toBe("skw");
    expect(first.profile).toBe("main-profile");

    const second = memoryRuntime.getMemoryRuntimeStatus({ cfg: builtinCfg, agentId: "main" });
    expect(second.backend).toBe("builtin");
    expect(second.profile).toBeUndefined();
  });

  it("plugin entry runtime delegates to the cached status implementation", () => {
    const runtime = registerMemoryCoreRuntime();
    const skwCfg = {
      memory: {
        backend: "skw",
        agents: {
          main: { backend: "skw", skw: { profile: "main-profile" } },
        },
        skw: {
          profileDefinitions: {
            "main-profile": {
              databasePath: "/nix/db.sqlite",
              memoryDatabasePath: "/nix/memory.sqlite",
              sessionMapPath: "/nix/session.json",
              cachePath: "/nix/cache",
              allowedCollections: [],
              allowedSourceRoots: [],
              limits: {
                recallMode: "hybrid",
                topK: 10,
                writable: true,
                autoExtract: true,
                extractor: "llm",
                maxWriteCharacters: 1000,
                maxInjectedCharacters: 2000,
                maxInjectedTokens: 500,
                minTurnsBetweenAttempts: 1,
                candidatePoolSize: 20,
                rerankThreshold: 0.5,
                maxChunksPerSource: 3,
                defaultTrust: 0.8,
                minTrust: 0.2,
                temporalDecayHalfLife: 24,
                rerankerModel: "default",
                rerankerCacheDir: "/tmp",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const direct = memoryRuntime.getMemoryRuntimeStatus({ cfg: skwCfg, agentId: "main" });
    const viaPlugin = runtime.getMemoryRuntimeStatus({ cfg: skwCfg, agentId: "main" });
    expect(viaPlugin).toBe(direct);
  });
});
