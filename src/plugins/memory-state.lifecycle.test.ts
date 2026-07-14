// Tests for the MemoryPluginRuntime lifecycle contract type.
import { describe, expect, it } from "vitest";
import type { MemoryPluginRuntime, MemoryRuntimeCapability } from "./memory-state.js";

describe("MemoryPluginRuntime lifecycle contract", () => {
  it("requires the lifecycle methods on a conforming runtime", () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return { manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" };
      },
      getMemoryRuntimeStatus() {
        return {
          backend: "builtin",
          ready: true,
          lastProbeAtMs: 0,
        };
      },
      async probeMemoryRuntime() {
        return { ok: true, latencyMs: 0 };
      },
      getMemoryRuntimeCapabilities() {
        return {
          backend: "builtin",
          features: new Set<MemoryRuntimeCapability>(["search", "get"]),
          writable: false,
          autoExtract: false,
          prefetch: false,
        };
      },
    };
    expect(runtime.getMemoryRuntimeStatus).toBeTypeOf("function");
    expect(runtime.probeMemoryRuntime).toBeTypeOf("function");
    expect(runtime.getMemoryRuntimeCapabilities).toBeTypeOf("function");
  });
});
