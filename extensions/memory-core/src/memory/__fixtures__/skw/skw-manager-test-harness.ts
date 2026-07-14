import { EventEmitter, Readable, Writable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { ResolvedSkwConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { expect, vi } from "vitest";

export const SKW_PROFILE = "host";
export const AGENT_ID = "agent";

type ManagedSkwManager = { close(): Promise<void> };
type ManagerFactory<T extends ManagedSkwManager> = {
  create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: { skw?: ResolvedSkwConfig };
  }): Promise<T | null>;
};

const trackedManagers: ManagedSkwManager[] = [];

export function trackManager(manager: ManagedSkwManager): void {
  trackedManagers.push(manager);
}

export async function closeTrackedManagers(): Promise<void> {
  while (trackedManagers.length > 0) {
    const manager = trackedManagers.pop();
    await manager?.close().catch(() => undefined);
  }
}

export type MockChildProcess = EventEmitter & {
  stdin: Writable & { chunks: (string | Buffer)[] };
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
};

export function createMockChildProcess(params: { autoCloseOnKill?: boolean } = {}) {
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
    if (typeof encodingOrCb === "function") encodingOrCb(null);
    else if (typeof cb === "function") cb(null);
    return true;
  };
  stdin.end = () => stdin;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => {
    if (params.autoCloseOnKill !== false) queueMicrotask(() => child.emit("close", 0, null));
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

export function parseFrames(stdin: MockChildProcess["stdin"]): Array<Record<string, unknown>> {
  return stdin.chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : chunk.toString("utf8")))
    .join("")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function takeFrames(stdin: MockChildProcess["stdin"]): Array<Record<string, unknown>> {
  const frames = parseFrames(stdin);
  stdin.chunks = [];
  return frames;
}

function writeOriginal(
  write: MockChildProcess["stdin"]["write"],
  chunk: string | Buffer,
  encodingOrCb?: BufferEncoding | null | ((error: Error | null | undefined) => void),
  cb?: (error: Error | null | undefined) => void,
): boolean {
  if (typeof encodingOrCb === "function") return write(chunk, encodingOrCb);
  if (typeof encodingOrCb === "string")
    return cb ? write(chunk, encodingOrCb, cb) : write(chunk, encodingOrCb);
  return cb ? write(chunk, cb) : write(chunk);
}

export function emitFrame(
  stdout: EventEmitter & Readable,
  response: Record<string, unknown>,
): void {
  stdout.emit("data", JSON.stringify(response) + "\n");
}

export function autoRespondToInitialize(child: ReturnType<typeof createMockChildProcess>): void {
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (
    chunk: string | Buffer,
    encodingOrCb?: BufferEncoding | null | ((error: Error | null | undefined) => void),
    cb?: (error: Error | null | undefined) => void,
  ): boolean => {
    const result = writeOriginal(originalWrite, chunk, encodingOrCb, cb);
    const lines = child.stdin.chunks
      .map((c) => (typeof c === "string" ? c : c.toString("utf8")))
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return result;
    const frame = JSON.parse(lastLine) as Record<string, unknown>;
    if (frame.op === "initialize")
      emitFrame(child.stdout, { version: 1, id: frame.id, ok: true, result: { ready: true } });
    return result;
  };
}

export function createSkwConfig(agentId: string, profile?: string): OpenClawConfig {
  return {
    memory: {
      backend: "skw",
      agents: profile ? { [agentId]: { backend: "skw", skw: { profile } } } : undefined,
      skw: {
        profileDefinitions: {
          [profile ?? SKW_PROFILE]: {
            databasePath: "/opt/skw-state/sona/skw.sqlite3",
            memoryDatabasePath: "/opt/skw-state/sona/provider/skw-memory.sqlite3",
            sessionMapPath: "/opt/skw-state/sona/provider/session-map.sqlite3",
            cachePath: "/opt/skw-cache/sona",
            allowedCollections: ["sona_private"],
            allowedSourceRoots: ["/opt/skw-private/sona"],
            limits: {
              recallMode: "hybrid",
              topK: 5,
              writable: true,
              autoExtract: false,
              extractor: "pattern",
              maxWriteCharacters: 16384,
              maxInjectedCharacters: 4000,
              maxInjectedTokens: 0,
              minTurnsBetweenAttempts: 0,
              candidatePoolSize: 20,
              rerankThreshold: 0.5,
              maxChunksPerSource: 1,
              defaultTrust: 0.5,
              minTrust: 0.3,
              temporalDecayHalfLife: 0,
              rerankerModel: "ms-marco-MiniLM-L-12-v2",
              rerankerCacheDir: "/opt/skw-reranker",
            },
          },
        },
      },
    },
    agents: { list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }] },
  } as OpenClawConfig;
}

export function createResolvedSkwConfig(params: {
  agentId: string;
  adapter?: Record<string, unknown>;
  profileDefinition?: Record<string, unknown>;
}): ResolvedSkwConfig {
  const cfg = createSkwConfig(params.agentId, SKW_PROFILE);
  const baseDefinition = cfg.memory?.skw?.profileDefinitions?.[SKW_PROFILE];
  if (!baseDefinition) throw new Error("SKW profile fixture expected");
  return {
    profiles: { [params.agentId]: SKW_PROFILE },
    profileDefinitions: { [SKW_PROFILE]: { ...baseDefinition, ...params.profileDefinition } },
    profile: SKW_PROFILE,
    adapter: {
      command: "skw-provider",
      args: [],
      cwd: "/tmp/workspace",
      timeoutMs: 30_000,
      ...params.adapter,
    },
  };
}

export function createManagerFactory<T extends ManagedSkwManager>(
  managerFactory: ManagerFactory<T>,
  spawnMock: ReturnType<typeof vi.fn>,
) {
  return async (
    params: {
      agentId?: string;
      adapter?: Record<string, unknown>;
      profileDefinition?: Record<string, unknown>;
      autoCloseOnKill?: boolean;
    } = {},
  ) => {
    const agentId = params.agentId ?? AGENT_ID;
    const childProcess = createMockChildProcess({ autoCloseOnKill: params.autoCloseOnKill });
    const originalWrite = childProcess.stdin.write.bind(childProcess.stdin);
    childProcess.stdin.write = (
      chunk: string | Buffer,
      encodingOrCb?: BufferEncoding | null | ((error: Error | null | undefined) => void),
      cb?: (error: Error | null | undefined) => void,
    ): boolean => {
      const result = writeOriginal(originalWrite, chunk, encodingOrCb, cb);
      const lines = childProcess.stdin.chunks
        .map((c) => (typeof c === "string" ? c : c.toString("utf8")))
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return result;
      const frame = JSON.parse(lastLine) as Record<string, unknown>;
      if (frame.op === "initialize")
        emitFrame(childProcess.stdout, {
          version: 1,
          id: frame.id,
          ok: true,
          result: {
            provider: "skw",
            protocolVersion: 1,
            ready: true,
            capabilities: {
              search: true,
              read: true,
              prefetch: true,
              write: true,
              extraction: true,
              compaction: true,
            },
          },
        });
      return result;
    };
    spawnMock.mockImplementation(() => childProcess.child);
    const manager = await managerFactory.create({
      cfg: createSkwConfig(agentId, SKW_PROFILE),
      agentId,
      resolved: {
        skw: createResolvedSkwConfig({
          agentId,
          adapter: params.adapter,
          profileDefinition: params.profileDefinition,
        }),
      },
    });
    if (!manager) throw new Error("manager expected");
    trackedManagers.push(manager);
    return { manager, ...childProcess };
  };
}

export async function waitForOperationFrame(
  stdin: MockChildProcess["stdin"],
  op: string,
): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(parseFrames(stdin).some((frame) => frame.op === op)).toBe(true));
  const frame = takeFrames(stdin).find((candidate) => candidate.op === op);
  if (!frame || typeof frame.id !== "string") throw new Error(`${op} frame expected`);
  return frame;
}

export async function respondToOperation(
  stdout: EventEmitter & Readable,
  stdin: MockChildProcess["stdin"],
  op: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const frame = await waitForOperationFrame(stdin, op);
  emitFrame(stdout, { version: 1, id: frame.id, ok: true, result });
  return frame;
}
