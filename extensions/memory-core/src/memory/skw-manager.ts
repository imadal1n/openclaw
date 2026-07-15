// Memory Core persistent SKW provider manager.
import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryEmbeddingProbeResult,
  MemoryLifecycleContext,
  MemoryPrefetchResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  ResolvedSkwConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { parseSkwPrefetchResult } from "./skw-prefetch.js";
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
    sessionKey: string;
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
type SkwSessionArtifactMetadata = {
  readonly agentId: string;
  readonly archived: boolean;
  readonly memoryKey: string;
  readonly sessionId: string;
  readonly sessionKey: string;
};
type SkwSearchResult = MemorySearchResult & {
  readonly sessionArtifact?: unknown;
  readonly metadata?: { readonly sessionArtifact?: unknown };
};
type SkwMemorySearchManagerParams = {
  readonly agentId: string;
  readonly resolved: ResolvedSkwConfig;
  readonly sessionMappingProvider?: SkwSessionMappingProvider;
};
type SignedHandleLease = {
  readonly agentId: string;
  readonly profile: string;
  readonly processKey: string;
  readonly process: SkwProviderProcess;
  readonly processGeneration: number;
  readonly processState: SkwProviderProcess["state"];
  readonly source: MemorySource;
  readonly sessionKey?: string;
  readonly sessionArtifact?: SkwSessionArtifactMetadata;
  readonly expiresAtMs: number;
};

const SIGNED_HANDLE_TTL_MS = 300_000;
const skwV1OpaqueHandlePattern = /^skw:\/\/v1\/[^/?#\s]+$/u;

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
  for (const [key, item] of Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))) {
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

function isSearchResult(value: unknown): value is SkwSearchResult {
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

function isSignedSkwReadHandle(value: string): boolean {
  return skwV1OpaqueHandlePattern.test(value);
}

function parseSessionArtifact(value: unknown): SkwSessionArtifactMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.agentId !== "string" ||
    typeof value.archived !== "boolean" ||
    typeof value.memoryKey !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.sessionKey !== "string" ||
    !value.agentId.trim() ||
    !value.memoryKey.trim() ||
    !value.sessionId.trim() ||
    !value.sessionKey.trim()
  ) {
    return undefined;
  }
  return {
    agentId: value.agentId,
    archived: value.archived,
    memoryKey: value.memoryKey,
    sessionId: value.sessionId,
    sessionKey: value.sessionKey,
  };
}

function sessionArtifactFromResult(
  result: SkwSearchResult,
): SkwSessionArtifactMetadata | undefined {
  return (
    parseSessionArtifact(result.sessionArtifact) ??
    parseSessionArtifact(result.metadata?.sessionArtifact)
  );
}

function signedHandlesFromResult(result: SkwSearchResult): string[] {
  return isSignedSkwReadHandle(result.path) ? [result.path] : [];
}

function parseSearchResults(value: unknown): SkwSearchResult[] {
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

function parseLifecycleResult(value: unknown): void {
  if (value !== undefined && !isRecord(value)) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "lifecycle result is malformed");
  }
}

export class SkwMemorySearchManager implements MemorySearchManager {
  private readonly keyParts: ProcessKeyParts;
  private readonly key: string;
  private readonly replacementKey: string;
  private readonly processConfig: SkwProviderProcessConfig;
  private readonly timeoutMs: number;
  private process: SkwProviderProcess | null = null;
  private statusCache: MemoryProviderStatus;
  private readonly signedHandleLeases = new Map<string, SignedHandleLease>();
  private closed = false;

  private constructor(private readonly params: SkwMemorySearchManagerParams) {
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
    const manager = new SkwMemorySearchManager({
      agentId: params.agentId,
      resolved,
      sessionMappingProvider: params.sessionMappingProvider,
    });
    await manager.initialize();
    return manager;
  }

  status(): MemoryProviderStatus {
    return this.statusCache;
  }

  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    const process = await this.ensureProcess();
    const sessionScope =
      this.params.sessionMappingProvider?.resolveSessionScope({
        agentId: this.params.agentId,
        sessionKey: opts?.sessionKey,
        sources: opts?.sources,
      }) ?? undefined;
    const result = await this.requestWithProcess(
      process,
      "search",
      {
        query,
        maxResults: opts?.maxResults,
        minScore: opts?.minScore,
        sessionKey: opts?.sessionKey,
        sessionScope,
        sources: opts?.sources,
      },
      opts?.signal,
    );
    await this.refreshStatusAfterOperation();
    const results = parseSearchResults(result);
    this.rememberSignedHandles(results, process, opts?.sessionKey);
    return results;
  }

  async prefetch(params: {
    query: string;
    sessionKey?: string;
    sessionId?: string;
  }): Promise<MemoryPrefetchResult> {
    const process = await this.ensureProcess();
    const sessionScope = this.params.sessionMappingProvider?.resolveSessionScope({
      agentId: this.params.agentId,
      sessionKey: params.sessionKey,
      sources: ["sessions"],
    });
    if (!params.sessionKey || !params.sessionId || !sessionScope) {
      return {};
    }
    const mapping = sessionScope.mappings.find(
      (candidate) => candidate.sessionKey === params.sessionKey,
    );
    if (!mapping || mapping.sessionId !== params.sessionId || mapping.archived) {
      return {};
    }
    const result = await this.requestWithProcess(
      process,
      "prefetch",
      { query: params.query },
      undefined,
      {
        agentId: this.params.agentId,
        profile: this.keyParts.profile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      },
    );
    await this.refreshStatusAfterOperation();
    return parseSkwPrefetchResult(result);
  }

  async memoryWrite(params: {
    eventId: string;
    content: string;
    metadata?: { category?: "user_pref" | "general" };
    sessionId?: string;
    sessionKey?: string;
  }): Promise<void> {
    const process = await this.ensureProcess();
    const result = await this.requestWithProcess(
      process,
      "memoryWrite",
      { eventId: params.eventId, content: params.content, metadata: params.metadata },
      undefined,
      {
        agentId: this.params.agentId,
        profile: this.keyParts.profile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      },
    );
    parseLifecycleResult(result);
    await this.refreshStatusAfterOperation();
  }

  async agentEnd(params: MemoryLifecycleContext): Promise<void> {
    await this.lifecycleRequest("agentEnd", params);
  }

  async prepareCompaction(params: MemoryLifecycleContext): Promise<void> {
    await this.lifecycleRequest("prepareCompaction", params);
  }

  async finishCompaction(params: MemoryLifecycleContext): Promise<void> {
    await this.lifecycleRequest("finishCompaction", params);
  }

  async endSession(params: MemoryLifecycleContext): Promise<void> {
    await this.lifecycleRequest("endSession", params);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
    sessionKey?: string;
  }): Promise<MemoryReadResult> {
    const process = this.authorizeReadProcess(params);
    const readParams = {
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    };
    const result = await (process
      ? this.requestWithProcess(process, "read", readParams)
      : this.request("read", readParams));
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

  private rememberSignedHandles(
    results: readonly MemorySearchResult[],
    process: SkwProviderProcess,
    sessionKey: string | undefined,
  ): void {
    for (const result of results) {
      for (const handle of signedHandlesFromResult(result)) {
        this.signedHandleLeases.set(handle, {
          agentId: this.params.agentId,
          profile: this.keyParts.profile,
          processKey: this.key,
          process,
          processGeneration: process.childGeneration,
          processState: process.state,
          source: result.source,
          sessionKey,
          sessionArtifact: sessionArtifactFromResult(result),
          expiresAtMs: Date.now() + SIGNED_HANDLE_TTL_MS,
        });
      }
    }
  }

  private authorizeReadProcess(params: {
    readonly relPath: string;
    readonly sessionKey?: string;
  }): SkwProviderProcess | null {
    if (!isSignedSkwReadHandle(params.relPath)) {
      if (params.relPath.startsWith("skw://")) {
        throw new SkwProviderError("DENIED", "signed SKW handle syntax is invalid");
      }
      return null;
    }
    const lease = this.signedHandleLeases.get(params.relPath);
    if (!lease) {
      throw new SkwProviderError("DENIED", "signed SKW handle was not issued by this manager");
    }
    if (lease.expiresAtMs <= Date.now()) {
      this.signedHandleLeases.delete(params.relPath);
      throw new SkwProviderError("DENIED", "signed SKW handle expired");
    }
    if (
      lease.agentId !== this.params.agentId ||
      lease.profile !== this.keyParts.profile ||
      lease.processKey !== this.key
    ) {
      throw new SkwProviderError("DENIED", "signed SKW handle identity mismatch");
    }
    if (
      this.process !== lease.process ||
      lease.processGeneration !== lease.process.childGeneration ||
      lease.process.state === "closing" ||
      lease.process.state === "closed" ||
      lease.process.state === "failed"
    ) {
      throw new SkwProviderError("DENIED", "signed SKW handle process is no longer alive");
    }
    if (lease.sessionKey !== params.sessionKey) {
      throw new SkwProviderError("DENIED", "signed SKW handle requester session mismatch");
    }
    if (lease.source !== "sessions") {
      return lease.process;
    }
    const artifact = lease.sessionArtifact;
    if (!artifact) {
      throw new SkwProviderError(
        "DENIED",
        "signed SKW session handle is missing identity metadata",
      );
    }
    if (artifact.archived) {
      throw new SkwProviderError(
        "DENIED",
        "signed SKW session handle points at an archived session",
      );
    }
    if (artifact.agentId !== this.params.agentId || artifact.sessionKey !== params.sessionKey) {
      throw new SkwProviderError("DENIED", "signed SKW session handle identity mismatch");
    }
    const currentScope = this.params.sessionMappingProvider?.resolveSessionScope({
      agentId: this.params.agentId,
      sessionKey: params.sessionKey,
      sources: ["sessions"],
    });
    const currentSession = currentScope?.mappings.find(
      (mapping) => mapping.sessionKey === params.sessionKey,
    );
    if (currentSession?.sessionId !== artifact.sessionId) {
      throw new SkwProviderError("DENIED", "signed SKW session handle is no longer current");
    }
    return lease.process;
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

  private async lifecycleRequest(
    op: "agentEnd" | "prepareCompaction" | "finishCompaction" | "endSession",
    params: MemoryLifecycleContext,
  ): Promise<void> {
    const process = await this.ensureProcess();
    const result = await this.requestWithProcess(process, op, {}, undefined, {
      agentId: this.params.agentId,
      profile: this.keyParts.profile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    parseLifecycleResult(result);
    await this.refreshStatusAfterOperation();
  }

  private async request(
    op: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const process = await this.ensureProcess();
    return this.requestWithProcess(process, op, params, signal);
  }

  private async requestWithProcess(
    process: SkwProviderProcess,
    op: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    identityOverride?: import("./skw-provider-framing.js").SkwProviderIdentity,
  ): Promise<unknown> {
    try {
      return await process.request({
        op,
        identity: identityOverride ?? this.identity(),
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
