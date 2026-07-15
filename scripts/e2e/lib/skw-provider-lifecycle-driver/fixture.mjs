// Fixture preparation and manager config construction for the SKW lifecycle driver.
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SHARED_WORKSPACE = "/home/limax/work/shared-knowledge-workspace";
const FIXTURE_SOURCE = path.join(SHARED_WORKSPACE, "tests", "fixtures", "openclaw-provider");

const REQUIRED_FILES = ["skw.sqlite3", "skw-memory.sqlite3"];

/**
 * @typedef {object} FixtureResult
 * @property {string} stateDir
 * @property {boolean} created
 */

/**
 * Prepare an isolated fixture state directory.
 *
 * If `fixturePath` is provided, it is used directly (must contain required DBs).
 * Otherwise, the bundled fixture is copied into a fresh directory under
 * `/tmp/opencode/todo10-e2e-*`.
 *
 * @param {string} [fixturePath]
 * @returns {FixtureResult}
 */
export function prepareFixture(fixturePath) {
  if (fixturePath) {
    const stateDir = path.resolve(fixturePath);
    if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) {
      throw new Error(`fixture is not a directory: ${stateDir}`);
    }
    const missing = REQUIRED_FILES.filter((name) => !existsSync(path.join(stateDir, name)));
    if (missing.length > 0) {
      throw new Error(`fixture missing required files: ${missing.join(", ")}`);
    }
    return { stateDir, created: false };
  }

  const baseDir = path.join(os.tmpdir(), "opencode");
  mkdirSync(baseDir, { recursive: true });
  const stateDir = mkdtempSync(path.join(baseDir, "todo10-e2e-"));
  if (!existsSync(FIXTURE_SOURCE) || !statSync(FIXTURE_SOURCE).isDirectory()) {
    throw new Error(`fixture source is not available: ${FIXTURE_SOURCE}`);
  }
  for (const name of REQUIRED_FILES) {
    const source = path.join(FIXTURE_SOURCE, name);
    if (!existsSync(source)) {
      throw new Error(`fixture source missing required file: ${source}`);
    }
  }
  cpSync(FIXTURE_SOURCE, stateDir, { recursive: true });
  return { stateDir, created: true };
}

/**
 * Return paths used by the standard initialize params.
 * @param {string} stateDir
 * @returns {{databasePath: string; memoryDatabasePath: string; sessionMapPath: string; cachePath: string}}
 */
export function resolveStatePaths(stateDir) {
  return {
    databasePath: path.join(stateDir, "skw.sqlite3"),
    memoryDatabasePath: path.join(stateDir, "skw-memory.sqlite3"),
    sessionMapPath: path.join(stateDir, "session-map.sqlite3"),
    cachePath: path.join(stateDir, "skw-cache"),
  };
}

/**
 * Build a ResolvedSkwConfig profile definition.
 * @param {string} stateDir
 * @param {string} profile
 * @returns {Record<string, unknown>}
 */
function buildProfileDefinition(stateDir, _profile) {
  const paths = resolveStatePaths(stateDir);
  return {
    databasePath: paths.databasePath,
    memoryDatabasePath: paths.memoryDatabasePath,
    sessionMapPath: paths.sessionMapPath,
    cachePath: paths.cachePath,
    allowedCollections: [],
    allowedSourceRoots: [stateDir],
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
      rerankerCacheDir: "",
    },
  };
}

/**
 * Build the manager config pair from a parsed provider command and fixture state.
 *
 * @param {string[]} providerCommand
 * @param {string} stateDir
 * @param {string} agentId
 * @param {string} profile
 * @param {number} [timeoutMs]
 * @param {Record<string, string>} [env]
 * @returns {{cfg: Record<string, unknown>, resolved: {skw: Record<string, unknown>}}}
 */
export function buildManagerConfig(
  providerCommand,
  stateDir,
  agentId,
  profile,
  timeoutMs = 30_000,
  env = {},
) {
  const [command, ...args] = providerCommand;
  const cwd = process.cwd();
  return {
    cfg: {
      memory: {
        backend: "skw",
        agents: {
          [agentId]: { backend: "skw", skw: { profile } },
        },
        skw: {
          profileDefinitions: {
            [profile]: buildProfileDefinition(stateDir, profile),
          },
        },
      },
      agents: { list: [{ id: agentId, default: true, workspace: cwd }] },
    },
    resolved: {
      skw: {
        profiles: { [agentId]: profile },
        profileDefinitions: { [profile]: buildProfileDefinition(stateDir, profile) },
        profile,
        adapter: { command, args, cwd, timeoutMs, env },
      },
    },
  };
}

/**
 * Default provider command using the shared workspace venv.
 * @returns {string[]}
 */
export function defaultProviderCommand() {
  return [path.join(SHARED_WORKSPACE, ".venv", "bin", "python"), "-m", "skw.openclaw_provider"];
}

/**
 * Parse a provider command string into an argv array.
 * @param {string} command
 * @returns {string[]}
 */
export function parseProviderCommand(command) {
  return command.trim().split(/\s+/u).filter(Boolean);
}

/**
 * Build a static session mapping provider for the manager prefetch path.
 *
 * @param {string} agentId
 * @param {string} profile
 * @param {Array<{sessionId: string; sessionKey: string; memoryKey: string}>} mappings
 * @returns {import("../../../extensions/memory-core/src/memory/skw-manager.ts").SkwSessionMappingProvider | undefined}
 */
export function makeSessionMappingProvider(agentId, profile, mappings) {
  return {
    resolveSessionScope(scopeParams) {
      if (scopeParams.agentId !== agentId) {
        return null;
      }
      const key = scopeParams.sessionKey ?? mappings[0]?.sessionKey;
      const mapping = mappings.find((candidate) => candidate.sessionKey === key) ?? mappings[0];
      if (!mapping) {
        return null;
      }
      return {
        sessionKey: key,
        sources: scopeParams.sources,
        mappings: mappings.map((candidate) => ({
          sourceId: candidate.sessionKey,
          agentId,
          sessionId: candidate.sessionId,
          sessionKey: candidate.sessionKey,
          memoryKey: candidate.memoryKey,
          archived: false,
        })),
      };
    },
  };
}

/**
 * Build a stable session memory key for the mapping provider.
 * @param {string} agentId
 * @param {string} sessionId
 * @returns {string}
 */
export function buildMemoryKey(agentId, sessionId) {
  return `agent:${agentId}:session:${sessionId}`;
}
