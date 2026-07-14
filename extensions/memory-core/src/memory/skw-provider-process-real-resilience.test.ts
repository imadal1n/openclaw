// Real-child process tests for SKW provider resilience and lifecycle.
import { vi } from "vitest";
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
} from "./skw-provider-process-helpers.js";

export function registerRealResilienceTests(): void {
  describe("SkwProviderProcess real child - resilience", () => {
    afterEach(async () => {
      await cleanup();
    });

    it("rejects active and queued on caller abort", async () => {
      const provider = createProvider();
      const controller = new AbortController();
      const active = provider.request({
        op: "slow",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      const queued = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      const activeRejected = expect(active).rejects.toMatchObject({ code: "ABORTED" });
      const queuedRejected = expect(queued).rejects.toMatchObject({ code: "UNAVAILABLE" });
      controller.abort();
      await activeRejected;
      await queuedRejected;
      await vi.waitFor(() => expect(provider.child).toBeNull());
    });

    it("rejects active and queued on request timeout", async () => {
      const provider = createProvider();
      const active = provider.request({
        op: "hang",
        identity: identity(),
        params: {},
        timeoutMs: 100,
      });
      const queued = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      const activeRejected = expect(active).rejects.toMatchObject({ code: "TIMEOUT" });
      const queuedRejected = expect(queued).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await activeRejected;
      await queuedRejected;
      await vi.waitFor(() => expect(provider.child).toBeNull());
    });

    it("escalates TERM to KILL when the child ignores SIGTERM", async () => {
      const provider = createProvider({
        env: { ...process.env, FAKE_CHILD_IGNORE_TERM: "1" },
      });
      const controller = new AbortController();
      const promise = provider.request({
        op: "hang",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      const promiseRejected = expect(promise).rejects.toMatchObject({ code: "ABORTED" });
      controller.abort();
      await promiseRejected;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await vi.waitFor(() => expect(provider.child).toBeNull());
    });

    it("immediately retries after abort when the old child ignores SIGTERM", async () => {
      const provider = createProvider({
        env: { ...process.env, FAKE_CHILD_IGNORE_TERM: "1" },
      });
      const controller = new AbortController();
      const active = provider.request({
        op: "hang",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      const activeRejected = expect(active).rejects.toMatchObject({ code: "ABORTED" });
      controller.abort();
      await activeRejected;

      const retry = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      await expect(retry).resolves.toEqual({ op: "status", received: {} });
      expect(provider.state).toBe("idle");
    });

    it("immediately retries after timeout when the old child ignores SIGTERM", async () => {
      const provider = createProvider({
        env: { ...process.env, FAKE_CHILD_IGNORE_TERM: "1" },
      });
      const active = provider.request({
        op: "hang",
        identity: identity(),
        params: {},
        timeoutMs: 100,
      });
      await expect(active).rejects.toMatchObject({ code: "TIMEOUT" });

      const retry = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      await expect(retry).resolves.toEqual({ op: "status", received: {} });
      expect(provider.state).toBe("idle");
    });

    it("captures the last 64 KiB of stderr in error details", async () => {
      const provider = createProvider({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("first warning\\nsecond warning\\n"); process.exit(1);'],
      });
      await expect(
        provider.request({
          op: "status",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
      expect(provider.lastStderr).toContain("second warning");
    });

    it("rejects pre-aborted request without spawning", async () => {
      const controller = new AbortController();
      controller.abort();
      const provider = createProvider();
      await expect(
        provider.request({
          op: "status",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(provider.state).toBe("starting");
      expect(provider.child).toBeNull();
    });

    it("rejects queued request when its signal aborts before processing", async () => {
      const provider = createProvider();
      const controller = new AbortController();
      const first = provider.request({
        op: "slow",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      const queued = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      const queuedRejected = expect(queued).rejects.toMatchObject({ code: "ABORTED" });
      controller.abort();
      await first;
      await queuedRejected;
    });

    it("closes cleanly and awaits child exit", async () => {
      const provider = createProvider();
      await provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await provider.close();
      expect(provider.state).toBe("closed");
      expect(provider.child).toBeNull();
    });

    it("closes a failed process only after the SIGTERM-ignoring child exits", async () => {
      const provider = createProvider({
        env: { ...process.env, FAKE_CHILD_IGNORE_TERM: "1" },
      });
      const controller = new AbortController();
      const active = provider.request({
        op: "hang",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(provider.activeRequest?.op).toBe("hang"));
      controller.abort();
      await expect(active).rejects.toMatchObject({ code: "ABORTED" });
      expect(provider.state).toBe("failed");
      expect(provider.child).not.toBeNull();

      await provider.close();
      expect(provider.state).toBe("closed");
      expect(provider.child).toBeNull();
    });

    it("rejects active and queued requests when closed", async () => {
      const provider = createProvider();
      const active = provider.request({
        op: "slow",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      const queued = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      const activeRejected = expect(active).rejects.toMatchObject({ code: "ABORTED" });
      const queuedRejected = expect(queued).rejects.toMatchObject({ code: "ABORTED" });
      await provider.close();
      await activeRejected;
      await queuedRejected;
      expect(provider.state).toBe("closed");
    });
  });
}
