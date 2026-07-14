// Memory Core persistent SKW provider manager.
import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  ResolvedSkwConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { PROTOCOL_VERSION, SkwProviderError } from "./skw-provider-framing.js";
import { skwProviderPool } from "./skw-provider-pool.js";
import { SkwProviderProcess, type SkwProviderProcessConfig } from "./skw-provider-process.js";

export type SkwSessionScope = {
  sessionKey: string;
  sources: string[];
  mappings: Array<{
    sourceId: string;
    agentId: string;
    sessionId: string;
    memoryKey: string;
    archived: boolean;
  }>;
};

export interface SkwSessionMappingProvider {
  resolveSessionScope(scopeParams: {
    agentId: string;
    sessionKey?: string;
    sources?: string[];
  }): SkwSessionScope | null;
}

type Adapter = { command: string; args: string[]; cwd: string; timeoutMs: number };
type ProcessKeyParts = {
  agentId: string;
  profile: string;
  databasePath: string | null;
  memoryDatabasePath: string | null;
  protocolVersion: number;
  configHash: string;
};
type ProbeKind = "embedding" | "vector";
type SearchOptions = NonNullable<Parameters<MemorySearchManager["search"]>[1]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultAdapter(resolved: ResolvedSkwConfig): Adapter {
  return {
    command: resolved.adapter?.command ?? "skw-provider",
    args: resolved.adapter?.args ?? [],
    cwd: resolved.adapter?.cwd ?? "/tmp/workspace",
    timeoutMs: resolved.adapter?.timeoutMs ?? 30_000,
  };
}

function profileDefinition(
  resolved: ResolvedSkwConfig,
  profile: string,
): ResolvedSkwConfig["profileDefinition"] {
  return resolved.profileDefinition ?? resolved.profileDefinitions?.[profile];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    sorted[key] = stableValue(item);
  }
  return sorted;
}

function configHash(resolved: ResolvedSkwConfig, profile: string): string {
  const payload = {
    adapter: defaultAdapter(resolved),
    effective: resolved.effective,
    profile: profileDefinition(resolved, profile),
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(payload)))
    .digest("hex");
}

function processKeyParts(agentId: string, resolved: ResolvedSkwConfig): ProcessKeyParts {
  const profile = resolved.profile ?? "default";
  const definition = profileDefinition(resolved, profile);
  return {
    agentId,
    profile,
    databasePath: definition?.databasePath ?? null,
    memoryDatabasePath: definition?.memoryDatabasePath ?? null,
    protocolVersion: PROTOCOL_VERSION,
    configHash: configHash(resolved, profile),
  };
}

function buildProcessConfig(resolved: ResolvedSkwConfig): SkwProviderProcessConfig {
  const adapter = defaultAdapter(resolved);
  return {
    command: adapter.command,
    args: adapter.args,
    cwd: adapter.cwd,
    env: {},
    logger: { warn: (message) => console.warn(message) },
  };
}

function statusFromPayload(params: {
  agentId: string;
  profile: string;
  payload: unknown;
  vectorAvailable?: boolean;
  lastError?: string;
}): MemoryProviderStatus {
  const payload = isRecord(params.payload) ? params.payload : {};
  const capabilities = isRecord(payload.capabilities) ? payload.capabilities : {};
  const embedding = capabilities.embedding === true;
  const vector = capabilities.vector === true;
  const available = payload.available === true || params.vectorAvailable === true || vector;
  const protocolVersion =
    typeof payload.protocolVersion === "number" ? payload.protocolVersion : PROTOCOL_VERSION;
  const lastError = typeof payload.lastError === "string" ? payload.lastError : params.lastError;
  return {
    backend: "skw",
    provider: typeof payload.provider === "string" ? payload.provider : "skw",
    custom: {
      skw: { profile: params.profile, agentId: params.agentId, protocolVersion, lastError },
    },
    vector: {
      enabled: embedding || vector || available,
      available,
      semanticAvailable: embedding || available,
      storeAvailable: vector,
    },
  };
}

function isMemorySource(value: unknown): value is MemorySource {
  return value === "memory" || value === "sessions";
}

function isSearchResult(value: unknown): value is MemorySearchResult {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.startLine === "number" &&
    typeof value.endLine === "number" &&
    typeof value.score === "number" &&
    typeof value.snippet === "string" &&
    isMemorySource(value.source)
  );
}

function parseSearchResults(value: unknown): MemorySearchResult[] {
  return isRecord(value) && Array.isArray(value.results)
    ? value.results.filter(isSearchResult)
    : [];
}

function parseReadResult(value: unknown): MemoryReadResult {
  if (!isRecord(value) || typeof value.text !== "string" || typeof value.path !== "string") {
    throw new SkwProviderError("MALFORMED_OUTPUT", "read result is malformed");
  }
  return { text: value.text, path: value.path };
}

export class SkwMemorySearchManager implements MemorySearchManager {
  private readonly keyParts: ProcessKeyParts;
  private readonly key: string;
  private readonly replacementKey: string;
  private readonly processConfig: SkwProviderProcessConfig;
  private readonly timeoutMs: number;
  private process: SkwProviderProcess | null = null;
  private statusCache: MemoryProviderStatus;
  private closed = false;

  private constructor(private readonly params: { agentId: string; resolved: ResolvedSkwConfig }) {
    this.keyParts = processKeyParts(params.agentId, params.resolved);
    this.key = JSON.stringify(this.keyParts);
    const replacementParts = {
      agentId: this.keyParts.agentId,
      profile: this.keyParts.profile,
      databasePath: this.keyParts.databasePath,
      memoryDatabasePath: this.keyParts.memoryDatabasePath,
      protocolVersion: this.keyParts.protocolVersion,
    };
    this.replacementKey = JSON.stringify(replacementParts);
    this.processConfig = buildProcessConfig(params.resolved);
    this.timeoutMs = defaultAdapter(params.resolved).timeoutMs;
    this.statusCache = statusFromPayload({
      agentId: params.agentId,
      profile: this.keyParts.profile,
      payload: {},
    });
  }

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: { skw?: ResolvedSkwConfig };
    sessionMappingProvider?: SkwSessionMappingProvider;
  }): Promise<SkwMemorySearchManager | null> {
    const resolved = params.resolved.skw;
    if (!resolved) {
      return null;
    }
    const manager = new SkwMemorySearchManager({ agentId: params.agentId, resolved });
    await manager.initialize();
    return manager;
  }

  status(): MemoryProviderStatus {
    return this.statusCache;
  }

  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    const result = await this.request(
      "search",
      {
        query,
        maxResults: opts?.maxResults,
        minScore: opts?.minScore,
        sessionKey: opts?.sessionKey,
        sources: opts?.sources,
      },
      opts?.signal,
    );
    await this.refreshStatusAfterOperation();
    return parseSearchResults(result);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult> {
    const result = await this.request("read", {
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
    await this.refreshStatusAfterOperation();
    return parseReadResult(result);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const available = await this.probe("embedding");
      return { ok: available, checked: true };
    } catch (err) {
      this.recordLastError(err);
      return { ok: false, error: err instanceof Error ? err.message : String(err), checked: true };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      return await this.probe("vector");
    } catch (err) {
      this.recordLastError(err);
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.process) {
      skwProviderPool.release(this.process);
      this.process = null;
    }
  }

  private async initialize(): Promise<void> {
    const definition = profileDefinition(this.params.resolved, this.keyParts.profile);
    const initParams = {
      protocolVersion: PROTOCOL_VERSION,
      profile: this.keyParts.profile,
      databasePath: definition?.databasePath,
      memoryDatabasePath: definition?.memoryDatabasePath,
      sessionMapPath: definition?.sessionMapPath,
      cachePath: definition?.cachePath,
      allowedCollections: definition?.allowedCollections,
      allowedSourceRoots: definition?.allowedSourceRoots,
      limits: definition?.limits,
    };
    const { process, status } = await skwProviderPool.acquire(
      this.key,
      () => new SkwProviderProcess(this.processConfig),
      async (p) =>
        statusFromPayload({
          agentId: this.params.agentId,
          profile: this.keyParts.profile,
          payload: await p.request({
            op: "initialize",
            identity: this.identity(),
            params: initParams,
            timeoutMs: this.timeoutMs,
          }),
        }),
      { replacementKey: this.replacementKey },
    );
    this.process = process;
    this.statusCache = status;
  }

  private identity() {
    return { agentId: this.params.agentId, profile: this.keyParts.profile };
  }

  private async ensureProcess(): Promise<SkwProviderProcess> {
    if (this.closed) {
      throw new SkwProviderError("UNAVAILABLE", "manager is closed", true);
    }
    if (this.process && this.process.state !== "closed" && this.process.state !== "closing") {
      return this.process;
    }
    await this.initialize();
    if (!this.process) {
      throw new SkwProviderError("UNAVAILABLE", "provider process unavailable", true);
    }
    return this.process;
  }

  private async request(
    op: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const process = await this.ensureProcess();
    try {
      return await process.request({
        op,
        identity: this.identity(),
        params,
        timeoutMs: this.timeoutMs,
        signal,
      });
    } catch (err) {
      this.recordLastError(err);
      throw err;
    }
  }

  private async probe(kind: ProbeKind): Promise<boolean> {
    const result = await this.request("probe", { kind });
    const available = isRecord(result) && result.available === true;
    await this.refreshStatusAfterOperation(available);
    return available;
  }

  private async refreshStatusAfterOperation(vectorAvailable?: boolean): Promise<void> {
    await this.refreshStatus(vectorAvailable).then(undefined, (err: unknown) => {
      this.recordLastError(err);
    });
  }

  private async refreshStatus(vectorAvailable?: boolean): Promise<void> {
    const result = await this.request("status", {});
    this.statusCache = statusFromPayload({
      agentId: this.params.agentId,
      profile: this.keyParts.profile,
      payload: result,
      vectorAvailable,
    });
    skwProviderPool.setStatus(this.key, this.statusCache);
  }

  private recordLastError(err: unknown): void {
    const lastError = err instanceof Error ? err.message : String(err);
    this.statusCache = statusFromPayload({
      agentId: this.params.agentId,
      profile: this.keyParts.profile,
      payload: this.statusCache,
      vectorAvailable: this.statusCache.vector?.available,
      lastError,
    });
    skwProviderPool.setStatus(this.key, this.statusCache);
  }
}

export {};
