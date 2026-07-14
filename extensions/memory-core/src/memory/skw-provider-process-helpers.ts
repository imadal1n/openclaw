// Shared test helpers for the persistent SKW provider process.
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import { EventEmitter, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SkwProviderError,
  SkwProviderProcess,
  type SkwProviderIdentity,
  type SkwProviderProcessConfig,
} from "./skw-provider-process.js";

export const FAKE_CHILD_SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  "../__fixtures__/skw/fake-skw-provider-process.mjs",
);

export const DEFAULT_TIMEOUT_MS = 1_000;

export type MockChildProcess = EventEmitter & {
  stdin: Writable & { chunks: (string | Buffer)[] };
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
};

export function createMockChildProcess(options?: { autoCloseOnKill?: boolean }) {
  const autoCloseOnKill = options?.autoCloseOnKill ?? true;
  const child = new EventEmitter() as MockChildProcess;
  const stdout = new EventEmitter() as EventEmitter & Readable;
  const stderr = new EventEmitter() as EventEmitter & Readable;
  const stdin = new EventEmitter() as EventEmitter & Writable & { chunks: (string | Buffer)[] };
  stdin.chunks = [];
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
    return true;
  };
  stdin.end = () => stdin;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    if (autoCloseOnKill || signal === "SIGKILL") {
      child.emit("close", signal === "SIGKILL" ? 0 : null, signal);
    }
    return true;
  });
  return {
    child,
    stdout,
    stderr,
    stdin,
    emitClose: (code: number, signal: string | null = null) => child.emit("close", code, signal),
  };
}

export function createProviderConfig(
  overrides?: Partial<SkwProviderProcessConfig>,
): SkwProviderProcessConfig {
  return {
    command: process.execPath,
    args: [FAKE_CHILD_SCRIPT],
    cwd: process.cwd(),
    env: { ...process.env },
    logger: { warn: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

export const trackedProviders: SkwProviderProcess[] = [];

export function createProvider(overrides?: Partial<SkwProviderProcessConfig>) {
  const provider = new SkwProviderProcess(createProviderConfig(overrides));
  trackedProviders.push(provider);
  return provider;
}

export function createMockProvider(
  overrides?: Partial<SkwProviderProcessConfig>,
  options?: { autoCloseOnKill?: boolean },
) {
  const provider = createProvider(overrides);
  const mock = createMockChildProcess(options);
  provider.spawn = () => mock.child as unknown as ChildProcess;
  return { provider, ...mock };
}

export async function cleanup() {
  while (trackedProviders.length > 0) {
    const provider = trackedProviders.pop();
    await provider?.close().catch(() => {});
  }
}

export function identity(overrides?: Partial<SkwProviderIdentity>): SkwProviderIdentity {
  return { agentId: "agent", profile: "host", ...overrides };
}

export function emitFrame(stdout: EventEmitter & Readable, response: Record<string, unknown>) {
  stdout.emit("data", JSON.stringify(response) + "\n");
}

export function emitInvalidUtf8(stdout: EventEmitter & Readable) {
  stdout.emit("data", Buffer.from([0xff, 0xfe, 0xfd, 0x0a]));
}

export function buildLargeParams(): Record<string, unknown> {
  return { data: "x".repeat(2 * 1024 * 1024) };
}

export function buildBackpressureParams(): Record<string, unknown> {
  return { data: "x".repeat(100 * 1024) };
}

export { SkwProviderError, SkwProviderProcess, afterEach, describe, expect, it, vi };
