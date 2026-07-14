import { SkwProviderError } from "./skw-provider-framing.js";

export type SkwPrefetchQuality = "fast" | "cached-full" | "abstain";

export type SkwPrefetchResponse = {
  context: string;
  quality: SkwPrefetchQuality;
  cacheKeyHash: string;
  queued: boolean;
  systemPromptBlock?: string;
};

const PREFETCH_QUALITY_VALUES = new Set<SkwPrefetchQuality>(["fast", "cached-full", "abstain"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrefetchQuality(value: unknown): value is SkwPrefetchQuality {
  return typeof value === "string" && PREFETCH_QUALITY_VALUES.has(value as SkwPrefetchQuality);
}

export function parseSkwPrefetchResult(
  value: unknown,
): Pick<SkwPrefetchResponse, "context" | "quality" | "systemPromptBlock"> {
  if (!isRecord(value)) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "prefetch result is not a JSON object");
  }
  if (typeof value.context !== "string") {
    throw new SkwProviderError("MALFORMED_OUTPUT", "prefetch result context is not a string");
  }
  if (!isPrefetchQuality(value.quality)) {
    throw new SkwProviderError(
      "MALFORMED_OUTPUT",
      "prefetch result quality must be one of: fast, cached-full, abstain",
    );
  }
  if (typeof value.cacheKeyHash !== "string") {
    throw new SkwProviderError("MALFORMED_OUTPUT", "prefetch result cacheKeyHash is not a string");
  }
  if (typeof value.queued !== "boolean") {
    throw new SkwProviderError("MALFORMED_OUTPUT", "prefetch result queued is not a boolean");
  }
  if ("systemPromptBlock" in value && typeof value.systemPromptBlock !== "string") {
    throw new SkwProviderError(
      "MALFORMED_OUTPUT",
      "prefetch result systemPromptBlock is not a string",
    );
  }
  const systemPromptBlock =
    "systemPromptBlock" in value && typeof value.systemPromptBlock === "string"
      ? value.systemPromptBlock
      : undefined;
  return {
    context: value.context,
    quality: value.quality,
    ...(systemPromptBlock ? { systemPromptBlock } : {}),
  };
}
