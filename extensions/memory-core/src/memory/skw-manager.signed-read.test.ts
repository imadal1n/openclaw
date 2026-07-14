import type { ResolvedSkwConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { formatSessionTranscriptMemoryHitKey } from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ID,
  SKW_PROFILE,
  autoRespondToInitialize,
  closeTrackedManagers,
  createMockChildProcess,
  createResolvedSkwConfig,
  createSkwConfig,
  emitFrame,
  parseFrames,
  respondToOperation,
  trackManager,
} from "./__fixtures__/skw/skw-manager-test-harness.js";
import { SkwMemorySearchManager, type SkwSessionMappingProvider } from "./skw-manager.js";
import { skwProviderPool } from "./skw-provider-pool.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

type TestSessionMapping = {
  readonly agentId: string;
  readonly archived: boolean;
  readonly memoryKey: string;
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly sourceId: string;
};

const SESSION_A = {
  agentId: AGENT_ID,
  archived: false,
  memoryKey: formatSessionTranscriptMemoryHitKey({ agentId: AGENT_ID, sessionId: "session-a" }),
  sessionId: "session-a",
  sessionKey: `agent:${AGENT_ID}:direct:a`,
  sourceId: `agent:${AGENT_ID}:direct:a`,
} satisfies TestSessionMapping;

const SESSION_B = {
  agentId: AGENT_ID,
  archived: false,
  memoryKey: formatSessionTranscriptMemoryHitKey({ agentId: AGENT_ID, sessionId: "session-b" }),
  sessionId: "session-b",
  sessionKey: `agent:${AGENT_ID}:direct:b`,
  sourceId: `agent:${AGENT_ID}:direct:b`,
} satisfies TestSessionMapping;

const SESSION_PATH = "skw://v1/session-current";
const MEMORY_PATH = "skw://v1/memory-source";

type ManagerHarness = Awaited<ReturnType<typeof createManagerHarness>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvedForProfile(agentId: string, profile: string): ResolvedSkwConfig {
  const resolved = createResolvedSkwConfig({ agentId });
  if (profile === SKW_PROFILE) {
    return resolved;
  }
  const definition = resolved.profileDefinitions?.[SKW_PROFILE];
  if (!definition) {
    throw new Error("base SKW profile definition expected");
  }
  return {
    ...resolved,
    profile,
    profiles: { [agentId]: profile },
    profileDefinitions: { [profile]: definition },
  };
}

function sessionMappingProvider(): SkwSessionMappingProvider {
  return {
    resolveSessionScope(scopeParams) {
      if (scopeParams.agentId !== AGENT_ID || !scopeParams.sources?.includes("sessions")) {
        return null;
      }
      return {
        sessionKey: scopeParams.sessionKey ?? "",
        sources: [...(scopeParams.sources ?? [])],
        mappings: [{ ...SESSION_A }, { ...SESSION_B }],
      };
    },
  };
}

async function createManagerHarness(params: { agentId?: string; profile?: string } = {}) {
  const agentId = params.agentId ?? AGENT_ID;
  const profile = params.profile ?? SKW_PROFILE;
  const child = createMockChildProcess();
  autoRespondToInitialize(child);
  spawnMock.mockImplementation(() => child.child);
  const manager = await SkwMemorySearchManager.create({
    cfg: createSkwConfig(agentId, profile),
    agentId,
    resolved: { skw: resolvedForProfile(agentId, profile) },
    sessionMappingProvider: sessionMappingProvider(),
  });
  if (!manager) {
    throw new Error("manager expected");
  }
  trackManager(manager);
  return { manager, ...child };
}

async function issueSessionHandle(
  harness: ManagerHarness,
  overrides: Record<string, unknown> = {},
) {
  const search = harness.manager.search("session", {
    maxResults: 2,
    sessionKey: SESSION_A.sessionKey,
    sources: ["sessions"],
  });
  const searchFrame = await respondToOperation(harness.stdout, harness.stdin, "search", {
    results: [
      {
        path: SESSION_PATH,
        source: "sessions",
        score: 1,
        snippet: "session memory",
        startLine: 20,
        endLine: 24,
        sessionArtifact: { ...SESSION_A, ...overrides },
      },
    ],
  });
  await respondToOperation(harness.stdout, harness.stdin, "status", {
    capabilities: { vector: true },
  });
  await search;
  return searchFrame;
}

async function issueMemoryHandle(harness: ManagerHarness) {
  const search = harness.manager.search("memory", { maxResults: 1 });
  await respondToOperation(harness.stdout, harness.stdin, "search", {
    results: [
      {
        path: MEMORY_PATH,
        source: "memory",
        score: 1,
        snippet: "memory",
        startLine: 1,
        endLine: 1,
      },
    ],
  });
  await respondToOperation(harness.stdout, harness.stdin, "status", {
    capabilities: { vector: true },
  });
  await search;
}

async function expectDeniedBeforeProviderRead(
  harness: ManagerHarness,
  request: { readonly relPath: string; readonly sessionKey?: string },
): Promise<void> {
  let settled = false;
  const read = harness.manager.readFile(request).finally(() => {
    settled = true;
  });
  void read.catch(() => undefined);
  let readFrame: Record<string, unknown> | undefined;
  await vi
    .waitFor(
      () => {
        readFrame = parseFrames(harness.stdin).find((frame) => frame.op === "read");
        expect(Boolean(readFrame) || settled).toBe(true);
      },
      { timeout: 100 },
    )
    .catch(() => undefined);
  if (readFrame) {
    emitFrame(harness.stdout, {
      version: 1,
      id: readFrame.id,
      ok: false,
      error: { code: "DENIED", message: "provider read should not be called" },
    });
  }
  await expect(read).rejects.toThrow(/denied|expired|forged|archived|identity|session/i);
  expect(readFrame).toBeUndefined();
}

describe("SkwMemorySearchManager signed read authorization", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
    await closeTrackedManagers();
    await skwProviderPool.closeAll();
  });

  it("sends canonical session map entries and authorizes the issued requester handle", async () => {
    // Given: the requester searches the sessions corpus with two same-agent mapped sessions.
    const harness = await createManagerHarness();

    // When: SKW search runs through the provider process.
    const searchFrame = await issueSessionHandle(harness);

    // Then: the provider sees a provider-neutral map with canonical sessionId+sessionKey pairs.
    expect(searchFrame.params).toMatchObject({
      sessionScope: {
        sessionKey: SESSION_A.sessionKey,
        mappings: [
          expect.objectContaining({ sessionId: "session-a", sessionKey: SESSION_A.sessionKey }),
          expect.objectContaining({ sessionId: "session-b", sessionKey: SESSION_B.sessionKey }),
        ],
      },
    });

    const read = harness.manager.readFile({
      relPath: SESSION_PATH,
      sessionKey: SESSION_A.sessionKey,
    });
    const readFrame = await respondToOperation(harness.stdout, harness.stdin, "read", {
      path: SESSION_PATH,
      text: "session text",
    });
    await respondToOperation(harness.stdout, harness.stdin, "status", {
      capabilities: { vector: true },
    });
    await expect(read).resolves.toMatchObject({ path: SESSION_PATH, text: "session text" });
    expect(readFrame.params).toMatchObject({ relPath: SESSION_PATH });
  });

  it("denies forged, archived, expired, cross-session, and missing-identity handles before read", async () => {
    const harness = await createManagerHarness();
    for (const relPath of [
      "skw://v1/forged-fake",
      "skw://v1/",
      "skw://v2/session-current",
      "skw://sessions/forged?chunk=x&sig=fake",
    ]) {
      await expectDeniedBeforeProviderRead(harness, { relPath, sessionKey: SESSION_A.sessionKey });
    }

    await issueSessionHandle(harness, { archived: true });
    await expectDeniedBeforeProviderRead(harness, {
      relPath: SESSION_PATH,
      sessionKey: SESSION_A.sessionKey,
    });

    await issueSessionHandle(harness, { sessionKey: undefined });
    await expectDeniedBeforeProviderRead(harness, {
      relPath: SESSION_PATH,
      sessionKey: SESSION_A.sessionKey,
    });

    await issueSessionHandle(harness);
    await expectDeniedBeforeProviderRead(harness, {
      relPath: SESSION_PATH,
      sessionKey: SESSION_B.sessionKey,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000);
    await issueSessionHandle(harness);
    nowSpy.mockReturnValue(1_000_301_000);
    await expectDeniedBeforeProviderRead(harness, {
      relPath: SESSION_PATH,
      sessionKey: SESSION_A.sessionKey,
    });
  });

  it("denies cross-agent and cross-profile handle replay before provider read", async () => {
    const original = await createManagerHarness();
    await issueMemoryHandle(original);

    const otherAgent = await createManagerHarness({ agentId: "other-agent" });
    await expectDeniedBeforeProviderRead(otherAgent, { relPath: MEMORY_PATH });

    const otherProfile = await createManagerHarness({ profile: "guest" });
    await expectDeniedBeforeProviderRead(otherProfile, { relPath: MEMORY_PATH });
  });

  it("does not respawn a dead provider process to read an old opaque handle", async () => {
    const harness = await createManagerHarness();
    await issueMemoryHandle(harness);
    harness.emitClose(0);

    await expectDeniedBeforeProviderRead(harness, { relPath: MEMORY_PATH });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

export {};
