// Mock-child process tests for the persistent SKW provider process.
import type { ChildProcess } from "node:child_process";
import { vi } from "vitest";
import {
  afterEach,
  describe,
  expect,
  it,
  DEFAULT_TIMEOUT_MS,
  SkwProviderError,
  cleanup,
  createMockChildProcess,
  createMockProvider,
  createProvider,
  emitFrame,
  emitInvalidUtf8,
  identity,
  trackedProviders,
} from "./skw-provider-process-helpers.js";

export function registerMockTests(): void {
  describe("SkwProviderProcess with mock child process", () => {
    afterEach(async () => {
      await cleanup();
    });

    it("invalidates the process on invalid UTF-8 in stdout", async () => {
      const { provider, stdout, emitClose } = createMockProvider();
      const promise = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      emitInvalidUtf8(stdout);
      emitClose(0);
      await expect(promise).rejects.toBeInstanceOf(SkwProviderError);
      await expect(promise).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("invalidates the process on oversized frame without newline", async () => {
      const { provider, stdout } = createMockProvider();
      const promise = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      stdout.emit("data", Buffer.alloc(1_048_576 + 1, 0x41));
      await expect(promise).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    });

    it("invalidates the process on malformed JSON", async () => {
      const { provider, stdout, emitClose } = createMockProvider();
      const promise = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      stdout.emit("data", "this is not json\n");
      emitClose(0);
      await expect(promise).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("invalidates the process on partial frame at EOF", async () => {
      const { provider, stdout, emitClose } = createMockProvider();
      const promise = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      stdout.emit("data", Buffer.from('{"version":1,"id":"x","ok":true', "utf8"));
      emitClose(0);
      await expect(promise).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("invalidates the process on unexpected response without active request", async () => {
      const { provider, stdout } = createMockProvider();
      const promise = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await vi.waitFor(() => expect(provider.activeRequest).not.toBeNull());
      emitFrame(stdout, { version: 1, id: provider.activeRequest!.id, ok: true, result: {} });
      await expect(promise).resolves.toEqual({});
      const second = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      emitFrame(stdout, { version: 1, id: "late", ok: true, result: {} });
      await expect(second).rejects.toMatchObject({ code: "MALFORMED_OUTPUT" });
    });

    it("waits for stream drain when write returns false", async () => {
      const { provider, stdout, stdin } = createMockProvider();
      stdin.write = (
        chunk: string | Buffer,
        encodingOrCb?: BufferEncoding | null | ((error: Error | null | undefined) => void),
        cb?: (error: Error | null | undefined) => void,
      ): boolean => {
        stdin.chunks.push(chunk);
        if (typeof encodingOrCb === "function") {
          encodingOrCb(null);
        } else if (typeof cb === "function") {
          cb(null);
        }
        return false; // backpressure
      };
      const promise = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
      });
      let resolved = false;
      promise.then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(resolved).toBe(false);
      stdin.emit("drain");
      emitFrame(stdout, { version: 1, id: provider.activeRequest!.id, ok: true, result: {} });
      await vi.waitFor(() => expect(resolved).toBe(true));
    });

    it("ignores stale close events from a previous child generation", async () => {
      const provider = createProvider();
      let callCount = 0;
      const firstMock = createMockChildProcess({ autoCloseOnKill: false });
      const secondMock = createMockChildProcess({ autoCloseOnKill: false });
      provider.spawn = () => {
        callCount += 1;
        return (callCount === 1 ? firstMock.child : secondMock.child) as unknown as ChildProcess;
      };
      trackedProviders.push(provider);

      const first = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await vi.waitFor(() => expect(provider.activeRequest).not.toBeNull());
      emitFrame(firstMock.stdout, {
        version: 1,
        id: provider.activeRequest!.id,
        ok: true,
        result: {},
      });
      await expect(first).resolves.toEqual({});

      const controller = new AbortController();
      const second = provider.request({
        op: "hang",
        identity: identity(),
        params: {},
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(provider.activeRequest?.op).toBe("hang"));
      controller.abort();
      await expect(second).rejects.toMatchObject({ code: "ABORTED" });

      const third = provider.request({
        op: "status",
        identity: identity(),
        params: {},
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      firstMock.emitClose(0); // legitimate close that unblocks the restart barrier
      await vi.waitFor(() => expect(provider.child).toBe(secondMock.child));
      firstMock.emitClose(0); // stale close from the old generation
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(provider.child).toBe(secondMock.child);
      expect(provider.state).toBe("busy");

      await vi.waitFor(() => expect(provider.activeRequest).not.toBeNull());
      emitFrame(secondMock.stdout, {
        version: 1,
        id: provider.activeRequest!.id,
        ok: true,
        result: { op: "status", received: {} },
      });
      await expect(third).resolves.toEqual({ op: "status", received: {} });
    });
  });
}
