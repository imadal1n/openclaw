import { randomUUID } from "node:crypto";
// Cross-repo frame tests: real SkwMemorySearchManager against the shared SKW provider.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkwMemorySearchManager } from "./skw-manager.js";
import { skwProviderPool } from "./skw-provider-pool.js";

const SHARED_WORKSPACE = "/home/limax/work/shared-knowledge-workspace";
const PROVIDER_COMMAND = [
  path.join(SHARED_WORKSPACE, ".venv", "bin", "python"),
  "-m",
  "skw.openclaw_provider",
];
const FIXTURE_SOURCE = path.join(SHARED_WORKSPACE, "tests", "fixtures", "openclaw-provider");
const AGENT_ID = "real-shared-agent";
const PROFILE = "fixture";

function buildProfileDefinition(stateDir: string) {
  return {
    databasePath: path.join(stateDir, "skw.sqlite3"),
    memoryDatabasePath: path.join(stateDir, "skw-memory.sqlite3"),
    sessionMapPath: path.join(stateDir, "session-map.sqlite3"),
    cachePath: path.join(stateDir, "skw-cache"),
    allowedCollections: [],
    allowedSourceRoots: [stateDir],
    limits: {
      recallMode: "hybrid" as const,
      topK: 5,
      writable: true,
      autoExtract: false,
      extractor: "pattern" as const,
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
      rerankerCacheDir: "",
    },
  };
}

function buildManagerConfig(stateDir: string) {
  const cwd = process.cwd();
  return {
    cfg: {
      memory: {
        backend: "skw" as const,
        agents: { [AGENT_ID]: { backend: "skw" as const, skw: { profile: PROFILE } } },
        skw: { profileDefinitions: { [PROFILE]: buildProfileDefinition(stateDir) } },
      },
      agents: { list: [{ id: AGENT_ID, default: true, workspace: cwd }] },
    },
    resolved: {
      skw: {
        profiles: { [AGENT_ID]: PROFILE },
        profileDefinitions: { [PROFILE]: buildProfileDefinition(stateDir) },
        profile: PROFILE,
        adapter: {
          command: PROVIDER_COMMAND[0],
          args: PROVIDER_COMMAND.slice(1),
          cwd,
          timeoutMs: 30_000,
          env: {
            HOME: stateDir,
            OPENCLAW_STATE_DIR: stateDir,
            PATH: process.env.PATH ?? "",
          },
        },
      },
    },
  };
}

function makeSessionMappingProvider(sessionId: string, sessionKey: string) {
  return {
    resolveSessionScope(scopeParams: { agentId: string; sessionKey?: string; sources?: string[] }) {
      if (scopeParams.agentId !== AGENT_ID) {
        return null;
      }
      return {
        sessionKey: scopeParams.sessionKey ?? sessionKey,
        sources: scopeParams.sources ?? ["sessions"],
        mappings: [
          {
            sourceId: sessionKey,
            agentId: AGENT_ID,
            sessionId,
            sessionKey,
            memoryKey: `agent:${AGENT_ID}:session:${sessionId}`,
            archived: false,
          },
        ],
      };
    },
  };
}

function prepareStateDir(): string {
  const base = path.join(os.tmpdir(), "opencode");
  if (!existsSync(base)) {
    mkdirSync(base, { recursive: true });
  }
  const stateDir = mkdtempSync(path.join(base, "skw-real-shared-"));
  cpSync(FIXTURE_SOURCE, stateDir, { recursive: true });
  return stateDir;
}

describe("SkwMemorySearchManager with real shared provider", () => {
  let stateDir: string;
  let manager: SkwMemorySearchManager | null;

  beforeEach(() => {
    stateDir = prepareStateDir();
    manager = null;
  });

  afterEach(async () => {
    await manager?.close().catch(() => {});
    await skwProviderPool.closeAll().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("initializes and reports SKW status", async () => {
    const { cfg, resolved } = buildManagerConfig(stateDir);
    manager = await SkwMemorySearchManager.create({
      cfg,
      agentId: AGENT_ID,
      resolved,
    });
    expect(manager).not.toBeNull();
    const status = manager!.status();
    expect(status.backend).toBe("skw");
    expect(status.vector?.available).toBe(true);
  });

  it("searches, reads, and rejects closed sessions", async () => {
    const sessionId = "sess-a";
    const sessionKey = "key-a";
    const nextSessionId = "sess-b";
    const nextSessionKey = "key-b";
    const { cfg, resolved } = buildManagerConfig(stateDir);
    manager = await SkwMemorySearchManager.create({
      cfg,
      agentId: AGENT_ID,
      resolved,
      sessionMappingProvider: makeSessionMappingProvider(sessionId, sessionKey),
    });

    const results = await manager!.search("First line", {
      maxResults: 5,
      sessionKey,
      sources: ["memory"],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.source).toBe("memory");

    const handle = results[0]?.path;
    expect(handle).toMatch(/^skw:\/\/v1\//);
    const read = await manager!.readFile({ relPath: handle, sessionKey });
    expect(read.text).toContain("First line");

    await manager!.memoryWrite({
      eventId: randomUUID(),
      target: "user",
      content: "operator note",
      metadata: {},
      sessionId,
      sessionKey,
    });

    await manager!.endSession({
      reason: "new",
      sessionId,
      sessionKey,
      nextSessionId,
      nextSessionKey,
    });
    await expect(
      manager!.search("note", { maxResults: 5, sessionKey, sources: ["memory"] }),
    ).rejects.toMatchObject({
      code: "DENIED",
    });
  });
});
