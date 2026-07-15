// Public memory host contracts shared by runtime, QMD, builtin search, and
// package consumers.
export type MemorySource = "memory" | "sessions";

export type SkwTruthTier =
  | "canonical"
  | "accepted"
  | "runtime_fact"
  | "working"
  | "raw_observation";
export type SkwVisibility = "shared" | "private";

export type SkwSessionArtifactMetadata = {
  readonly agentId: string;
  readonly archived: boolean;
  readonly memoryKey: string;
  readonly sessionId: string;
  readonly sessionKey: string;
};

export type SkwMemoryMetadata = {
  readonly backend: "skw";
  readonly category?: "user_pref" | "general";
  readonly truthTier?: SkwTruthTier;
  readonly visibility?: SkwVisibility;
  readonly priority?: string | number;
  readonly authority?: string;
  readonly sourceType?: string;
  readonly primaryReason?: string;
  readonly matchReasons?: readonly string[];
  readonly expandedQuery?: string;
  readonly ranking?: Readonly<Record<string, unknown>>;
  readonly displayPath?: string;
  readonly collection?: string;
  readonly handles?: readonly string[];
  readonly sessionArtifact?: SkwSessionArtifactMetadata;
};

export type SkwMemoryMetadataCarrier = {
  readonly metadata?: SkwMemoryMetadata;
  readonly truthTier?: unknown;
  readonly visibility?: unknown;
  readonly priority?: unknown;
  readonly authority?: unknown;
  readonly sourceType?: unknown;
  readonly primaryReason?: unknown;
  readonly matchReasons?: unknown;
  readonly expandedQuery?: unknown;
  readonly ranking?: unknown;
  readonly displayPath?: unknown;
  readonly collection?: unknown;
  readonly handles?: unknown;
  readonly sessionArtifact?: unknown;
};

/** One ranked memory search hit with optional vector/text scoring details. */
export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
} & SkwMemoryMetadataCarrier;

/** Cached/probed embedding availability status. */
export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

/** Progress event emitted during memory sync. */
export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemorySessionSyncTarget = {
  /** Owning OpenClaw agent. Omit only when the active manager scope already supplies it. */
  agentId?: string;
  /** Storage-neutral transcript/session identity. */
  sessionId: string;
  /** Optional visible session-store key for callers that already carry it. */
  sessionKey?: string;
};

export type MemorySyncParams = {
  reason?: string;
  force?: boolean;
  /** Storage-neutral session transcript targets to refresh. */
  sessions?: MemorySessionSyncTarget[];
  /**
   * @deprecated Use `sessions` with `{ agentId, sessionId, sessionKey? }`.
   * During the deprecation window only canonical OpenClaw transcript paths are accepted.
   */
  sessionFiles?: string[];
  progress?: (update: MemorySyncProgressUpdate) => void;
};

/** Runtime backend/mode diagnostics for memory search. */
export type MemorySearchRuntimeDebug = {
  backend: "builtin" | "qmd" | "skw";
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
};

/** Result of reading a memory file, optionally paginated/truncated. */
export type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
} & SkwMemoryMetadataCarrier;

/** Aggregated memory backend status for CLI/UI diagnostics. */
export type MemoryProviderStatus = {
  backend: "builtin" | "qmd" | "skw";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    storeAvailable?: boolean;
    semanticAvailable?: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

export type MemoryPrefetchQuality = "fast" | "cached-full" | "abstain";

/** Result of a prefetch recall call, returning static guidance and dynamic recall context. */
export type MemoryPrefetchResult = {
  context?: string;
  quality?: MemoryPrefetchQuality;
  systemPromptBlock?: string;
};

/** Context shared by memory lifecycle hooks and write operations. */
export type MemoryLifecycleContext = {
  sessionId?: string;
  sessionKey?: string;
};

/** Search/read/sync/status/lifecycle contract implemented by memory managers. */
export interface MemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      /** Optional caller cancellation; managers consume it where their runtime supports cancellation. */
      signal?: AbortSignal;
    },
  ): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
    sessionKey?: string;
  }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: MemorySyncParams): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
  /**
   * Optional automatic recall prefetch before prompt build.
   * Implemented by SKW managers to inject static guidance and recall context.
   */
  prefetch?(params: {
    query: string;
    sessionKey?: string;
    sessionId?: string;
  }): Promise<MemoryPrefetchResult>;
  /**
   * Optional bounded operator write to a writable SKW backend.
   * Implemented by SKW managers; QMD and builtin backends return unsupported.
   */
  memoryWrite?(
    params: MemoryLifecycleContext & {
      eventId: string;
      content: string;
      metadata?: { category?: "user_pref" | "general" };
    },
  ): Promise<void>;
  agentEnd?(params: MemoryLifecycleContext): Promise<void>;
  prepareCompaction?(params: MemoryLifecycleContext): Promise<void>;
  finishCompaction?(params: MemoryLifecycleContext): Promise<void>;
  endSession?(params: MemoryLifecycleContext): Promise<void>;
}
