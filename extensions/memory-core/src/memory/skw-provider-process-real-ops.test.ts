// Real-child process tests for SKW provider operations.
import {
  afterEach,
  describe,
  expect,
  it,
  DEFAULT_TIMEOUT_MS,
  SkwProviderError,
  cleanup,
  createProvider,
  identity,
  vi,
} from "./skw-provider-process-helpers.js";

export function registerRealOpsTests(): void {
  describe("SkwProviderProcess real child - operations", () => {
    afterEach(async () => {
      await cleanup();
    });

    it("spawns the configured command and sends a versioned request", async () => {
      const provider = createProvider();
      const result = await provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(result).toEqual({ op: "status", received: {} });
      expect(provider.state).toBe("idle");
    });

    it("reuses a single child process for sequential requests", async () => {
      const provider = createProvider();
      const first = await provider.request({
        op: "status",
        identity: identity(),
        params: { index: 0 },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(first).toEqual({ op: "status", received: { index: 0 } });
      const second = await provider.request({
        op: "probe",
        identity: identity(),
        params: { kind: "embedding" },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(second).toEqual({ op: "probe", received: { kind: "embedding" } });
    });

    it("queues up to 32 pending requests and rejects overflow with UNAVAILABLE", async () => {
      const provider = createProvider();
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 33; i += 1) {
        promises.push(
          provider.request({
            op: "hang",
            identity: identity(),
            params: {},
            timeoutMs: 5_000,
          }),
        );
      }
      const results = await Promise.allSettled(promises);
      expect(results[32].status).toBe("rejected");
      if (results[32].status === "rejected") {
        expect(results[32].reason).toBeInstanceOf(SkwProviderError);
        expect(results[32].reason).toMatchObject({ code: "UNAVAILABLE" });
      }
    });

    it("uses only the configured env and does not inherit unrelated process.env secrets", async () => {
      process.env.TEST_ECHO_SECRET = "should-not-leak";
      const provider = createProvider({
        env: { TEST_ECHO_VISIBLE: "yes" },
      });
      try {
        const result = await provider.request({
          op: "env",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
        expect(result).toEqual({
          env: { TEST_ECHO_VISIBLE: "yes" },
        });
      } finally {
        delete process.env.TEST_ECHO_SECRET;
      }
    });

    it("processes queued requests in FIFO order", async () => {
      const provider = createProvider();
      const results: number[] = [];
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 3; i += 1) {
        promises.push(
          provider
            .request({
              op: "status",
              identity: identity(),
              params: { index: i },
              timeoutMs: 5_000,
            })
            .then((value) => {
              results.push((value as { received: { index: number } }).received.index);
            }),
        );
      }
      await Promise.all(promises);
      expect(results).toEqual([0, 1, 2]);
    });

    it("rejects a typed provider error envelope", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "error",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "DENIED" });
    });

    it("restarts the process once after a failure and surfaces error on second failure", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "crash",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
      expect(provider.state).toBe("failed");

      const result = await provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(result).toEqual({ op: "status", received: {} });
      expect(provider.state).toBe("idle");

      await expect(
        provider.request({
          op: "crash",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });

      await expect(
        provider.request({
          op: "status",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
    });

    it("shuts down gracefully by sending shutdown then awaiting child exit", async () => {
      const provider = createProvider();
      await provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await provider.shutdown({ reason: "manager-close", timeoutMs: 5_000 });
      expect(provider.state).toBe("closed");
      expect(provider.child).toBeNull();
    });

    it("kills the child if shutdown times out", async () => {
      const provider = createProvider({
        env: { ...process.env, FAKE_CHILD_SHUTDOWN_HANG: "1" },
      });
      await provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await expect(
        provider.shutdown({ reason: "manager-close", timeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(provider.state).toBe("closed");
      await vi.waitFor(() => expect(provider.child).toBeNull());
    });
  });
}
