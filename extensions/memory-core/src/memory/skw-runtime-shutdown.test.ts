import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./search-manager.js";
import { SkwProviderError } from "./skw-provider-framing.js";

const AGENT_ID = "runtime-skw";
const PROFILE = "host";

function providerCode(paths: { pid: string; op: string }): string {
  return `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(paths.pid)}, String(process.pid));
    let buffer = "";
    function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(paths.op)}, frame.op + "\\n");
        if (frame.op === "initialize" || frame.op === "status") {
          send({ version: 1, id: frame.id, ok: true, result: { protocolVersion: 1, capabilities: { embedding: true, vector: true } } });
        }
      }
    });
  `;
}

function cfg(root: string, code: string): OpenClawConfig {
  return {
    memory: {
      backend: "skw",
      agents: { [AGENT_ID]: { backend: "skw", skw: { profile: PROFILE } } },
      skw: {
        adapter: { command: process.execPath, args: ["-e", code], cwd: root, timeoutMs: 60_000 },
        profileDefinitions: {
          [PROFILE]: {
            databasePath: path.join(root, "skw.sqlite3"),
            memoryDatabasePath: path.join(root, "memory.sqlite3"),
            sessionMapPath: path.join(root, "session-map.sqlite3"),
            cachePath: path.join(root, "cache"),
            allowedCollections: ["sona_private"],
            allowedSourceRoots: [root],
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
              rerankerCacheDir: path.join(root, "reranker"),
            },
          },
        },
      },
    },
    agents: { list: [{ id: AGENT_ID, default: true, workspace: root }] },
  } satisfies OpenClawConfig;
}

async function readPid(file: string): Promise<number> {
  await vi.waitFor(async () => expect(Number(await readFile(file, "utf8"))).toBeGreaterThan(0));
  return Number(await readFile(file, "utf8"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killIfAlive(pid: number): Promise<void> {
  if (isAlive(pid)) process.kill(pid, "SIGTERM");
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return await Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
}

describe("runtime SKW shutdown", () => {
  beforeEach(async () => await closeAllMemorySearchManagers());
  afterEach(async () => await closeAllMemorySearchManagers());

  it("rejects active and queued requests and leaves no child after runtime close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openclaw-skw-runtime-close-"));
    const paths = { pid: path.join(root, "pid"), op: path.join(root, "ops") };
    let pid = 0;
    try {
      const { manager } = await getMemorySearchManager({
        cfg: cfg(root, providerCode(paths)),
        agentId: AGENT_ID,
      });
      if (!manager) throw new Error("SKW manager expected");
      pid = await readPid(paths.pid);
      const active = manager.search("active", { maxResults: 1 }).catch((err: unknown) => err);
      await vi.waitFor(async () => expect(await readFile(paths.op, "utf8")).toContain("search"));
      const queued = manager
        .readFile({ relPath: "provider://queued" })
        .catch((err: unknown) => err);

      await closeAllMemorySearchManagers();
      const settled = await settleWithin(Promise.all([active, queued]), 500);

      expect(settled).not.toBe("timeout");
      if (settled === "timeout") throw new Error("requests should settle during runtime close");
      const [activeError, queuedError] = settled;
      expect(activeError).toBeInstanceOf(SkwProviderError);
      expect(queuedError).toBeInstanceOf(SkwProviderError);
      await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
      await expect(stat(`/proc/${pid}`)).rejects.toThrow();
    } finally {
      if (pid > 0) await killIfAlive(pid);
      await rm(root, { recursive: true, force: true });
    }
  });
});
