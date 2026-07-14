import type {
  MemoryReadResult,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveSkwMetadata,
  type ResolvedSkwMetadata,
  type SkwMetadataFields,
} from "./tools.skw-metadata.parse.js";

type SkwSearchResult = MemorySearchResult & SkwMetadataFields;
type SkwReadResult = MemoryReadResult & SkwMetadataFields;
const skwV1OpaqueHandlePattern = /^skw:\/\/v1\/[^/?#\s]+$/u;

export function isSignedSkwReadPath(value: string): boolean {
  return skwV1OpaqueHandlePattern.test(value);
}

export function normalizeSkwMemorySearchResult(
  result: SkwSearchResult,
  backend: string,
): MemorySearchResult & { readonly metadata?: ResolvedSkwMetadata } {
  const {
    truthTier,
    visibility,
    priority,
    authority,
    sourceType,
    primaryReason,
    matchReasons,
    expandedQuery,
    ranking,
    displayPath,
    collection,
    handles,
    sessionArtifact,
    metadata,
    ...base
  } = result;
  if (backend !== "skw") {
    return base;
  }
  if (!isSignedSkwReadPath(result.path)) {
    throw new Error("skw metadata path is invalid");
  }
  const skwMetadata = resolveSkwMetadata({
    truthTier,
    visibility,
    priority,
    authority,
    sourceType,
    primaryReason,
    matchReasons,
    expandedQuery,
    ranking,
    displayPath,
    collection,
    handles,
    sessionArtifact,
    metadata,
  });
  return skwMetadata ? { ...base, metadata: skwMetadata } : base;
}

export function normalizeSkwMemoryReadResult(
  result: SkwReadResult,
  backend: string,
): MemoryReadResult & { readonly metadata?: ResolvedSkwMetadata } {
  const {
    truthTier,
    visibility,
    priority,
    authority,
    sourceType,
    primaryReason,
    matchReasons,
    expandedQuery,
    ranking,
    displayPath,
    collection,
    handles,
    sessionArtifact,
    metadata,
    ...base
  } = result;
  if (backend !== "skw") {
    return base;
  }
  if (!isSignedSkwReadPath(result.path)) {
    throw new Error("skw metadata path is invalid");
  }
  const skwMetadata = resolveSkwMetadata({
    truthTier,
    visibility,
    priority,
    authority,
    sourceType,
    primaryReason,
    matchReasons,
    expandedQuery,
    ranking,
    displayPath,
    collection,
    handles,
    sessionArtifact,
    metadata,
  });
  return skwMetadata ? { ...base, metadata: skwMetadata } : base;
}
