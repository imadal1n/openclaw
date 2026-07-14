const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type SkwSessionArtifactMetadata = {
  readonly agentId: string;
  readonly archived: boolean;
  readonly memoryKey: string;
  readonly sessionId: string;
  readonly sessionKey: string;
};

export type ResolvedSkwMetadata = {
  readonly backend: "skw";
  readonly truthTier?: "canonical" | "accepted" | "runtime_fact" | "working" | "raw_observation";
  readonly visibility?: "shared" | "private";
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

export type SkwMetadataFields = {
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
  readonly metadata?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeToken(value: string): boolean {
  return safeTokenPattern.test(value) && !value.includes("..");
}

function parseTruthTier(value: unknown): ResolvedSkwMetadata["truthTier"] {
  if (
    value === "canonical" ||
    value === "accepted" ||
    value === "runtime_fact" ||
    value === "working" ||
    value === "raw_observation"
  ) {
    return value;
  }
  throw new Error("skw metadata truthTier is invalid");
}

function parseVisibility(value: unknown): ResolvedSkwMetadata["visibility"] {
  if (value === "shared" || value === "private") {
    return value;
  }
  throw new Error("skw metadata visibility is invalid");
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`skw metadata ${fieldName} is invalid`);
}

function parsePriority(value: unknown): string | number {
  if ((typeof value === "string" && value.trim()) || typeof value === "number") {
    return value;
  }
  throw new Error("skw metadata priority is invalid");
}

function parseMatchReasons(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("skw metadata matchReasons are invalid");
  }
  for (const reason of value) {
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("skw metadata matchReason is invalid");
    }
  }
  return value;
}

function parseRanking(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  throw new Error("skw metadata ranking is invalid");
}

function parseCollection(value: unknown): string {
  if (typeof value === "string" && isSafeToken(value)) {
    return value;
  }
  throw new Error("skw metadata collection is invalid");
}

function parseHandles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("skw metadata handles are invalid");
  }
  for (const handle of value) {
    if (typeof handle !== "string" || !isSafeToken(handle)) {
      throw new Error("skw metadata handle is invalid");
    }
  }
  return value;
}

function parseSessionArtifact(value: unknown): NonNullable<ResolvedSkwMetadata["sessionArtifact"]> {
  if (!isRecord(value)) {
    throw new Error("skw metadata sessionArtifact is invalid");
  }
  if (
    typeof value.agentId !== "string" ||
    typeof value.archived !== "boolean" ||
    typeof value.memoryKey !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.sessionKey !== "string" ||
    !value.agentId ||
    !value.memoryKey ||
    !value.sessionId ||
    !value.sessionKey
  ) {
    throw new Error("skw metadata sessionArtifact is invalid");
  }
  return {
    agentId: value.agentId,
    archived: value.archived,
    memoryKey: value.memoryKey,
    sessionId: value.sessionId,
    sessionKey: value.sessionKey,
  };
}

export function resolveSkwMetadata(fields: SkwMetadataFields): ResolvedSkwMetadata | undefined {
  if (fields.metadata !== undefined && !isRecord(fields.metadata)) {
    throw new Error("skw metadata is invalid");
  }
  const nested = isRecord(fields.metadata) ? fields.metadata : {};
  if (nested.backend !== undefined && nested.backend !== "skw") {
    throw new Error("skw metadata backend is invalid");
  }
  const values = {
    truthTier: fields.truthTier ?? nested.truthTier,
    visibility: fields.visibility ?? nested.visibility,
    priority: fields.priority ?? nested.priority,
    authority: fields.authority ?? nested.authority,
    sourceType: fields.sourceType ?? nested.sourceType,
    primaryReason: fields.primaryReason ?? nested.primaryReason,
    matchReasons: fields.matchReasons ?? nested.matchReasons,
    expandedQuery: fields.expandedQuery ?? nested.expandedQuery,
    ranking: fields.ranking ?? nested.ranking,
    displayPath: fields.displayPath ?? nested.displayPath,
    collection: fields.collection ?? nested.collection,
    handles: fields.handles ?? nested.handles,
    sessionArtifact: fields.sessionArtifact ?? nested.sessionArtifact,
  };
  if (
    fields.metadata === undefined &&
    Object.values(values).every((value) => value === undefined)
  ) {
    return undefined;
  }
  return {
    backend: "skw",
    ...(values.truthTier === undefined ? {} : { truthTier: parseTruthTier(values.truthTier) }),
    ...(values.visibility === undefined ? {} : { visibility: parseVisibility(values.visibility) }),
    ...(values.priority === undefined ? {} : { priority: parsePriority(values.priority) }),
    ...(values.authority === undefined
      ? {}
      : { authority: parseRequiredString(values.authority, "authority") }),
    ...(values.sourceType === undefined
      ? {}
      : { sourceType: parseRequiredString(values.sourceType, "sourceType") }),
    ...(values.primaryReason === undefined
      ? {}
      : { primaryReason: parseRequiredString(values.primaryReason, "primaryReason") }),
    ...(values.matchReasons === undefined
      ? {}
      : { matchReasons: parseMatchReasons(values.matchReasons) }),
    ...(values.expandedQuery === undefined
      ? {}
      : { expandedQuery: parseRequiredString(values.expandedQuery, "expandedQuery") }),
    ...(values.ranking === undefined ? {} : { ranking: parseRanking(values.ranking) }),
    ...(values.displayPath === undefined
      ? {}
      : { displayPath: parseRequiredString(values.displayPath, "displayPath") }),
    ...(values.collection === undefined ? {} : { collection: parseCollection(values.collection) }),
    ...(values.handles === undefined ? {} : { handles: parseHandles(values.handles) }),
    ...(values.sessionArtifact === undefined
      ? {}
      : { sessionArtifact: parseSessionArtifact(values.sessionArtifact) }),
  };
}
