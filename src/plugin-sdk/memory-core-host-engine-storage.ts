/**
 * Public SDK subpath for memory host storage, indexing, and search primitives.
 */
export {
  buildFileEntry,
  buildMemoryReadResult,
  buildMemoryReadResultFromSlice,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  cosineSimilarity,
  DEFAULT_MEMORY_READ_LINES,
  DEFAULT_MEMORY_READ_MAX_CHARS,
  ensureDir,
  ensureMemoryIndexSchema,
  hashText,
  isFileMissingError,
  isTransientMemoryReadError,
  listMemoryFiles,
  loadSqliteVecExtension,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  readMemoryFile,
  retryTransientMemoryRead,
  remapChunkLines,
  requireNodeSqlite,
  resolveMemoryBackendConfig,
  runWithConcurrency,
  statRegularFile,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

/** Origin bucket for memory search results exposed through the SDK. */
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

/** Normalized search hit shape returned by memory host searches. */
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

/** Health probe result for embedding provider availability checks. */
export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

export type {
  AgentEndParams,
  EndSessionParams,
  FinishCompactionParams,
  MemoryChunk,
  MemoryFileEntry,
  MemoryLifecycleContext,
  MemoryMessage,
  MemoryPrefetchQuality,
  MemoryPrefetchResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySessionSyncTarget,
  MemorySyncParams,
  MemorySyncProgressUpdate,
  MemoryWriteParams,
  PrepareCompactionParams,
  PrepareCompactionResult,
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
  ResolvedSkwConfig,
} from "../../packages/memory-host-sdk/src/engine-storage.js";
