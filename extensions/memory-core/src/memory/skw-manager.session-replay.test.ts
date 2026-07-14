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

const SESSION_KEY = `agent:${AGENT_ID}:direct:a`;
const SESSION_A = {
  agentId: AGENT_ID,
  archived: false,
  memoryKey: formatSessionTranscriptMemoryHitKey({ agentId: AGENT_ID, sessionId: "session-a" }),
  sessionId: "session-a",
  sessionKey: SESSION_KEY,
  sourceId: SESSION_KEY,
} satisfies Record<string, string | boolean>;
const SESSION_B_SAME_KEY = {
  ...SESSION_A,
  memoryKey: formatSessionTranscriptMemoryHitKey({ agentId: AGENT_ID, sessionId: "session-b" }),
  sessionId: "session-b",
} satisfies Record<string, string | boolean>;
const SESSION_PATH = "skw://v1/session-current";

type TestSessionMapping = typeof SESSION_A;
type ManagerHarness = Awaited<ReturnType<typeof createManagerHarness>>;

function sessionMappingProvider(
  mappings: () => readonly TestSessionMapping[],
): SkwSessionMappingProvider {
  return {
    resolveSessionScope(scopeParams) {
      if (scopeParams.agentId !== AGENT_ID || !scopeParams.sources?.includes("sessions")) {
        return null;
      }
      return {
        sessionKey: scopeParams.sessionKey ?? "",
        sources: scopeParams.sources,
        mappings: [...mappings()],
      };
    },
  };
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

async function createManagerHarness(provider: SkwSessionMappingProvider) {
  const child = createMockChildProcess();
  autoRespondToInitialize(child);
  spawnMock.mockImplementation(() => child.child);
  const manager = await SkwMemorySearchManager.create({
    cfg: createSkwConfig(AGENT_ID, SKW_PROFILE),
    agentId: AGENT_ID,
    resolved: { skw: resolvedForProfile(AGENT_ID, SKW_PROFILE) },
    sessionMappingProvider: provider,
  });
  if (!manager) {
    throw new Error("manager expected");
  }
  trackManager(manager);
  return { manager, ...child };
}

async function issueSessionAHandle(harness: ManagerHarness): Promise<void> {
  const search = harness.manager.search("session", {
    maxResults: 1,
    sessionKey: SESSION_KEY,
    sources: ["sessions"],
  });
  await respondToOperation(harness.stdout, harness.stdin, "search", {
    results: [
      {
        path: SESSION_PATH,
        source: "sessions",
        score: 1,
        snippet: "session memory",
        startLine: 20,
        endLine: 24,
        sessionArtifact: SESSION_A,
      },
    ],
  });
  await respondToOperation(harness.stdout, harness.stdin, "status", {
    capabilities: { vector: true },
  });
  await search;
}

async function expectDeniedBeforeProviderRead(harness: ManagerHarness): Promise<void> {
  let settled = false;
  const read = harness.manager
    .readFile({ relPath: SESSION_PATH, sessionKey: SESSION_KEY })
    .finally(() => {
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
  await expect(read).rejects.toThrow(/denied|session/i);
  expect(readFrame).toBeUndefined();
}

describe("SkwMemorySearchManager session replay authorization", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
    await closeTrackedManagers();
    await skwProviderPool.closeAll();
  });

  it("denies same-key session handle replay after the requester session id changes", async () => {
    // Given: search issued a handle for sessionId A under the requester session key.
    let mappings: readonly TestSessionMapping[] = [SESSION_A];
    const harness = await createManagerHarness(sessionMappingProvider(() => mappings));
    await issueSessionAHandle(harness);

    // When: the same visible session key now resolves to sessionId B before read.
    mappings = [SESSION_B_SAME_KEY];

    // Then: manager authorization denies locally instead of forwarding provider read.
    await expectDeniedBeforeProviderRead(harness);
  });
});

export {};
