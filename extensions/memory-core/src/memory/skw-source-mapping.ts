// Map OpenClaw high-level memory sources to the granular source types accepted
// by the shared SKW provider, and back again for search results.

export const SKW_MEMORY_SOURCE_TYPES = [
  "project",
  "technical",
  "technical_log",
  "research",
  "entity",
  "memory_candidate",
];

export const SKW_SESSIONS_SOURCE_TYPES = [
  "daily_journal",
  "conversation_cleaned",
  "transcript_matrix",
  "transcript_shadow",
  "letter",
  "dream",
];

const SOURCE_TYPE_TO_MEMORY_SOURCE = new Map<string, "memory" | "sessions">([
  ...SKW_MEMORY_SOURCE_TYPES.map((t) => [t, "memory"] as const),
  ...SKW_SESSIONS_SOURCE_TYPES.map((t) => [t, "sessions"] as const),
]);

export function expandSkwSources(sources: readonly string[] | undefined): string[] | undefined {
  if (!sources || sources.length === 0) {
    return undefined;
  }
  const expanded = new Set<string>();
  for (const source of sources) {
    if (source === "memory") {
      for (const t of SKW_MEMORY_SOURCE_TYPES) {
        expanded.add(t);
      }
    } else if (source === "sessions") {
      for (const t of SKW_SESSIONS_SOURCE_TYPES) {
        expanded.add(t);
      }
    } else {
      expanded.add(source);
    }
  }
  return [...expanded];
}

export function normalizeSkwSourceType(sourceType: string): "memory" | "sessions" {
  if (sourceType === "memory" || sourceType === "sessions") {
    return sourceType;
  }
  return SOURCE_TYPE_TO_MEMORY_SOURCE.get(sourceType) ?? "memory";
}

export function normalizeSkwSourceTypeOptional(
  sourceType: string | undefined,
): "memory" | "sessions" | undefined {
  if (sourceType === undefined) {
    return undefined;
  }
  return normalizeSkwSourceType(sourceType);
}
