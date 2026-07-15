import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_ACTIVE_MEMORY_RUNTIME_SHUTDOWN_TIMEOUT_MS,
  runGatewayStopMemoryPrelude,
} from "./server-skw-memory-shutdown.js";

type GatewayShutdownStep = "global-stop" | "memory-runtime" | "close-prelude";

describe("gateway active-memory runtime shutdown seam", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the injected active-memory runtime after global stop and before close prelude", async () => {
    const events: GatewayShutdownStep[] = [];
    const warn = vi.fn<(message: string) => void>();
    const fakeRuntime = {
      ownedChildren: [] as const,
      closeAllMemorySearchManagers: vi.fn(async () => {
        events.push("memory-runtime");
      }),
    };

    await runGatewayStopMemoryPrelude({
      runGlobalGatewayStopSafely: async () => {
        events.push("global-stop");
      },
      closeMemoryRuntime: fakeRuntime.closeAllMemorySearchManagers,
      runClosePrelude: async () => {
        events.push("close-prelude");
      },
      warn,
    });

    expect(events).toStrictEqual(["global-stop", "memory-runtime", "close-prelude"]);
    expect(fakeRuntime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(fakeRuntime.ownedChildren).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("continues to close prelude after the 6s active-memory runtime deadline", async () => {
    vi.useFakeTimers();
    const events: GatewayShutdownStep[] = [];
    const warn = vi.fn<(message: string) => void>();
    const closeMemoryRuntime = vi.fn(() => {
      events.push("memory-runtime");
      return new Promise<void>(() => {});
    });
    const closePrelude = vi.fn(async () => {
      events.push("close-prelude");
    });

    const closePromise = runGatewayStopMemoryPrelude({
      runGlobalGatewayStopSafely: async () => {
        events.push("global-stop");
      },
      closeMemoryRuntime,
      runClosePrelude: closePrelude,
      warn,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(closeMemoryRuntime).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GATEWAY_ACTIVE_MEMORY_RUNTIME_SHUTDOWN_TIMEOUT_MS - 1);
    expect(closePrelude).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await closePromise;

    expect(events).toStrictEqual(["global-stop", "memory-runtime", "close-prelude"]);
    expect(closeMemoryRuntime).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "active memory runtime shutdown timed out after 6000ms; continuing shutdown",
    );
  });

  it("continues to close prelude when active-memory runtime close fails", async () => {
    const events: GatewayShutdownStep[] = [];
    const warn = vi.fn<(message: string) => void>();
    const closeMemoryRuntime = vi.fn(async () => {
      events.push("memory-runtime");
      throw new Error("skw close failed");
    });
    const closePrelude = vi.fn(async () => {
      events.push("close-prelude");
    });

    await runGatewayStopMemoryPrelude({
      runGlobalGatewayStopSafely: async () => {
        events.push("global-stop");
      },
      closeMemoryRuntime,
      runClosePrelude: closePrelude,
      warn,
    });

    expect(events).toStrictEqual(["global-stop", "memory-runtime", "close-prelude"]);
    expect(closeMemoryRuntime).toHaveBeenCalledTimes(1);
    expect(closePrelude).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "active memory runtime shutdown failed: skw close failed; continuing shutdown",
    );
  });
});
