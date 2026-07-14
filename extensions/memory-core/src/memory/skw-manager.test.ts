// Tests for the persistent SKW provider manager and global process pool.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ID,
  SKW_PROFILE,
  autoRespondToInitialize,
  closeTrackedManagers,
  createManagerFactory,
  createMockChildProcess,
  createResolvedSkwConfig,
  createSkwConfig,
  emitFrame,
  parseFrames,
  respondToOperation,
  trackManager,
  waitForOperationFrame,
} from "./__fixtures__/skw/skw-manager-test-harness.js";
import { SkwMemorySearchManager } from "./skw-manager.js";
import { SkwProviderError } from "./skw-provider-framing.js";
import { skwProviderPool } from "./skw-provider-pool.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});
const createManager = createManagerFactory(SkwMemorySearchManager, spawnMock);

describe("SkwMemorySearchManager persistent process", () => {
  beforeEach(() => spawnMock.mockReset());

  afterEach(async () => {
    await closeTrackedManagers();
    await skwProviderPool.closeAll();
  });

  it("sends initialize with profile params on creation", async () => {
    const { stdin } = await createManager();
    const frames = parseFrames(stdin);
    expect(frames[0]).toMatchObject({ version: 1, op: "initialize" });
    expect(frames[0]?.params).toMatchObject({
      protocolVersion: 1,
      databasePath: "/opt/skw-state/sona/skw.sqlite3",
      memoryDatabasePath: "/opt/skw-state/sona/provider/skw-memory.sqlite3",
      profile: SKW_PROFILE,
      allowedCollections: ["sona_private"],
    });
  });

  it("returns cached status synchronously after initialize", async () => {
    const { manager } = await createManager();
    const status = manager.status();
    expect(status.backend).toBe("skw");
    expect(status.provider).toBe("skw");
    expect(status.custom?.skw).toMatchObject({ profile: SKW_PROFILE });
  });

  it("reuses the same process for multiple searches on the same manager", async () => {
    const { manager, stdout, stdin } = await createManager();

    const firstPromise = manager.search("hello", { maxResults: 5 });
    await respondToOperation(stdout, stdin, "search", {
      results: [
        {
          path: "skw://v1/a",
          startLine: 1,
          endLine: 2,
          snippet: "hello",
          score: 0.9,
          source: "memory",
        },
      ],
    });
    await respondToOperation(stdout, stdin, "status", {
      capabilities: { embedding: true, vector: true },
    });
    await firstPromise;

    const secondPromise = manager.search("world", { maxResults: 3 });
    await respondToOperation(stdout, stdin, "search", { results: [] });
    await respondToOperation(stdout, stdin, "status", {
      capabilities: { embedding: true, vector: true },
    });
    await secondPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("sends search/read with the new NDJSON envelope", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.search("query", { maxResults: 5 });
    const frame = await respondToOperation(stdout, stdin, "search", { results: [] });
    await respondToOperation(stdout, stdin, "status", {
      capabilities: { embedding: true, vector: true },
    });
    await promise;

    expect(frame).toMatchObject({
      version: 1,
      op: "search",
      identity: { agentId: AGENT_ID, profile: SKW_PROFILE },
    });
    expect(frame.params).toEqual({ query: "query", maxResults: 5 });
  });

  it("caches status after a completed operation", async () => {
    const { manager, stdout, stdin } = await createManager();
    const firstStatus = manager.status();

    const promise = manager.search("x", { maxResults: 1 });
    await respondToOperation(stdout, stdin, "search", { results: [] });
    await respondToOperation(stdout, stdin, "status", {
      protocolVersion: 1,
      capabilities: { embedding: true, vector: true },
    });
    await promise;
    const secondStatus = manager.status();

    expect(secondStatus).not.toBe(firstStatus);
    expect(secondStatus.vector).toMatchObject({ enabled: true, available: true });
  });

  it("probes embedding availability with the normative probe op", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.probeEmbeddingAvailability();
    const frame = await respondToOperation(stdout, stdin, "probe", { available: true });
    await respondToOperation(stdout, stdin, "status", {
      protocolVersion: 1,
      capabilities: { embedding: true, vector: false },
    });
    const result = await promise;

    expect(frame.params).toEqual({ kind: "embedding" });
    expect(result.ok).toBe(true);
    expect(manager.status().vector?.available).toBe(true);
  });

  it("probes vector availability instead of returning cached status", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.probeVectorAvailability();
    const frame = await respondToOperation(stdout, stdin, "probe", { available: true });
    await respondToOperation(stdout, stdin, "status", {
      protocolVersion: 1,
      capabilities: { embedding: true, vector: true },
    });

    expect(frame.params).toEqual({ kind: "vector" });
    await expect(promise).resolves.toBe(true);
  });

  it("shares the process pool across different manager instances with the same key", async () => {
    const first = await createManager();
    await createManager({ agentId: AGENT_ID });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const firstPromise = first.manager.search("a", { maxResults: 1 });
    await respondToOperation(first.stdout, first.stdin, "search", { results: [] });
    await respondToOperation(first.stdout, first.stdin, "status", {
      capabilities: { embedding: true, vector: true },
    });
    await firstPromise;
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("creates a new process for a different profile/database key", async () => {
    await createManager({ agentId: "agent-a" });
    await createManager({ agentId: "agent-b" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("returns UNAVAILABLE when all four global slots are busy", async () => {
    const children: ReturnType<typeof createMockChildProcess>[] = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChildProcess();
      autoRespondToInitialize(child);
      children.push(child);
      return child.child;
    });

    const managers: SkwMemorySearchManager[] = [];
    for (let i = 0; i < 4; i += 1) {
      const manager = await SkwMemorySearchManager.create({
        cfg: createSkwConfig(`agent-${i}`, SKW_PROFILE),
        agentId: `agent-${i}`,
        resolved: { skw: createResolvedSkwConfig({ agentId: `agent-${i}` }) },
      });
      if (!manager) throw new Error("manager expected");
      managers.push(manager);
      trackManager(manager);
    }

    // Block all four processes with a pending request.
    const pending: Promise<unknown>[] = [];
    for (const manager of managers) {
      pending.push(manager.search("block", { maxResults: 1 }));
    }
    await vi.waitFor(() =>
      expect(children.every((c) => parseFrames(c.stdin).length > 0)).toBe(true),
    );

    await expect(
      SkwMemorySearchManager.create({
        cfg: createSkwConfig("agent-5", SKW_PROFILE),
        agentId: "agent-5",
        resolved: { skw: createResolvedSkwConfig({ agentId: "agent-5" }) },
      }),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    } satisfies Partial<SkwProviderError>);
    const close = skwProviderPool.closeAll();
    await Promise.allSettled(pending);
    await close;
  });

  it("rejects active searches and awaits child cleanup during closeAll", async () => {
    const { manager, child, stdin, emitClose } = await createManager({ autoCloseOnKill: false });
    const search = manager.search("block", { maxResults: 1 });
    await waitForOperationFrame(stdin, "search");

    let settled = false;
    const close = skwProviderPool.closeAll().then(() => {
      settled = true;
    });
    await expect(search).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    } satisfies Partial<SkwProviderError>);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    expect(settled).toBe(false);

    emitClose(0);
    await close;
    expect(settled).toBe(true);
  });

  it("cached idle managers do not block a fifth manager", async () => {
    const children: ReturnType<typeof createMockChildProcess>[] = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChildProcess();
      autoRespondToInitialize(child);
      children.push(child);
      return child.child;
    });

    for (let i = 0; i < 4; i += 1) {
      const manager = await SkwMemorySearchManager.create({
        cfg: createSkwConfig(`idle-agent-${i}`, SKW_PROFILE),
        agentId: `idle-agent-${i}`,
        resolved: { skw: createResolvedSkwConfig({ agentId: `idle-agent-${i}` }) },
      });
      if (!manager) throw new Error("manager expected");
      trackManager(manager);
    }

    const fifthManager = await SkwMemorySearchManager.create({
      cfg: createSkwConfig("agent-5", SKW_PROFILE),
      agentId: "agent-5",
      resolved: { skw: createResolvedSkwConfig({ agentId: "agent-5" }) },
    });
    if (!fifthManager) throw new Error("manager expected");
    trackManager(fifthManager);

    expect(children[0]?.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("evicts the least recently used idle process and awaits cleanup before replacement", async () => {
    const children = new Map<string, ReturnType<typeof createMockChildProcess>>();
    const nowSpy = vi.spyOn(Date, "now");
    let now = 0;
    nowSpy.mockImplementation(() => {
      now += 10;
      return now;
    });
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts?: Record<string, unknown>) => {
        const cwd = typeof opts?.cwd === "string" ? opts.cwd : "";
        const agentId = cwd.split("-").pop() ?? "";
        const child = createMockChildProcess({ autoCloseOnKill: agentId !== "0" });
        autoRespondToInitialize(child);
        children.set(agentId, child);
        return child.child;
      },
    );

    const managers: SkwMemorySearchManager[] = [];
    for (let i = 0; i < 4; i += 1) {
      const manager = await SkwMemorySearchManager.create({
        cfg: createSkwConfig(`agent-${i}`, SKW_PROFILE),
        agentId: `agent-${i}`,
        resolved: {
          skw: createResolvedSkwConfig({
            agentId: `agent-${i}`,
            adapter: { cwd: `/tmp/workspace-${i}` },
          }),
        },
      });
      if (!manager) throw new Error("manager expected");
      managers.push(manager);
      trackManager(manager);
    }

    // Close the first manager to make its process idle.
    await managers[0].close();

    const evicted = children.get("0");
    if (!evicted) throw new Error("agent-0 child expected");

    let replacementSettled = false;
    const fifthPromise = SkwMemorySearchManager.create({
      cfg: createSkwConfig("agent-5", SKW_PROFILE),
      agentId: "agent-5",
      resolved: {
        skw: createResolvedSkwConfig({ agentId: "agent-5", adapter: { cwd: "/tmp/workspace-5" } }),
      },
    }).then((manager) => {
      replacementSettled = true;
      return manager;
    });

    try {
      await vi.waitFor(() => expect(evicted.child.kill).toHaveBeenCalledWith("SIGTERM"));
      expect(replacementSettled).toBe(false);
    } finally {
      nowSpy.mockRestore();
      evicted.emitClose(0);
    }

    const fifth = await fifthPromise;
    if (!fifth) throw new Error("manager expected");
    trackManager(fifth);

    expect(spawnMock).toHaveBeenCalledTimes(5);
    expect(replacementSettled).toBe(true);
  });

  it("closes the stale process when config changes before replacement", async () => {
    const { manager, child } = await createManager();
    await manager.close();

    const { child: newChild } = await createManager({
      profileDefinition: { allowedCollections: ["sona_private", "sona_new"] },
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(newChild).not.toBe(child);
  });

  it("propagates provider errors for non-SKW adapter read paths", async () => {
    const { manager, stdout, stdin } = await createManager();

    const promise = manager.readFile({ relPath: "provider://tampered" });
    const frame = await waitForOperationFrame(stdin, "read");
    emitFrame(stdout, {
      version: 1,
      id: frame.id,
      ok: false,
      error: { code: "DENIED", message: "handle expired" },
    });

    await expect(promise).rejects.toThrow("DENIED");
  });

  it("closes all processes on manager close", async () => {
    const { manager, child } = await createManager();
    await manager.close();
    await skwProviderPool.closeAll();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

export {};
