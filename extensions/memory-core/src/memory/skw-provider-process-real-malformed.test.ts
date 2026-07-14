// Real-child process tests for SKW provider malformed-output handling.
import { vi } from "vitest";
import {
  afterEach,
  describe,
  expect,
  it,
  DEFAULT_TIMEOUT_MS,
  cleanup,
  createProvider,
  identity,
  buildLargeParams,
  buildBackpressureParams,
} from "./skw-provider-process-helpers.js";

export function registerRealMalformedTests(): void {
  describe("SkwProviderProcess real child - malformed and boundary", () => {
    afterEach(async () => {
      await cleanup();
    });

    it("invalidates the process on unexpected stdout from child", async () => {
      const provider = createProvider({
        env: { ...process.env, FAKE_CHILD_STARTUP_NOISE: "1" },
      });
      await expect(
        provider.request({
          op: "status",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
      await vi.waitFor(() => expect(provider.child).toBeNull());
    });

    it("invalidates the process on oversized incoming frame", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "oversized",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
      await vi.waitFor(() => expect(provider.child).toBeNull());
    });

    it("invalidates the process on response with mismatched version", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "wrong-version",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("invalidates the process on response with mismatched id", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "wrong-id",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("invalidates the process on duplicate response", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "duplicate",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).resolves.toEqual({ first: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(provider.state).toBe("failed");
      await expect(
        provider.request({
          op: "status",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
    });

    it("invalidates the process on unknown response field", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "unknown-field",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("invalidates the process on unknown error field", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "unknown-error-field",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("invalidates the process on unknown error code", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "error-unknown-code",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("rejects frame with both result and error", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "mixed-envelope",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("rejects failure frame that also contains a result", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "error-with-result",
          identity: identity(),
          params: {},
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("rejects outgoing frame exceeding 1 MiB", async () => {
      const provider = createProvider();
      await expect(
        provider.request({
          op: "status",
          identity: identity(),
          params: buildLargeParams(),
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    });

    it("experiences backpressure when child does not read stdin", async () => {
      const provider = createProvider({
        env: { ...process.env, FAKE_CHILD_NEVER_READ: "1" },
      });
      const promise = provider.request({
        op: "status",
        identity: identity(),
        params: buildBackpressureParams(),
        timeoutMs: 300,
      });
      let resolved = false;
      promise
        .catch(() => {})
        .finally(() => {
          resolved = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(resolved).toBe(false);
      await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
    });
  });
}
