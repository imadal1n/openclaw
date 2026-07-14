import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
} from "./memory-tool-manager.test-mocks.js";
import { testing as memoryToolsTesting } from "./tools.js";
import { createMemoryGetToolOrThrow, createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

const signedPath = "skw://v1/source-file-line";
const invalidSkwReadPathCases = [
  { name: "old unsigned shape", path: "skw://memory/source-file-line" },
  { name: "empty v1 handle", path: "skw://v1/" },
  { name: "wrong version", path: "skw://v2/source-file-line" },
  {
    name: "legacy query-string signature",
    path: "skw://memory/source-file-line?chunk=source-line&sig=valid-source-line",
  },
] as const;

const sharedSkwMetadata = {
  backend: "skw",
  truthTier: "accepted",
  visibility: "shared",
  priority: "high",
  authority: "operator-plan",
  sourceType: "plan",
  primaryReason: "title-match",
  matchReasons: ["title-match", "body-match"],
  expandedQuery: "fixture expanded query",
  ranking: { semantic: 0.74, lexical: 0.26, rank: 1 },
  displayPath: "MEMORY.md:12-14",
  collection: "memory",
  handles: ["memory:source-file-line"],
} as const;

type InvalidMetadataCase = {
  readonly name: string;
  readonly patch: Record<string, unknown>;
  readonly error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchMetadataJson(details: unknown): string {
  if (!isRecord(details) || !Array.isArray(details.results) || !isRecord(details.results[0])) {
    throw new Error("memory_search details missing first result metadata");
  }
  return JSON.stringify(details.results[0].metadata);
}

function readMetadataJson(details: unknown): string {
  if (!isRecord(details)) {
    throw new Error("memory_get details missing metadata");
  }
  return JSON.stringify(details.metadata);
}

function skwSearchHit(patch: Record<string, unknown> = {}) {
  return {
    path: signedPath,
    startLine: 12,
    endLine: 14,
    score: 0.97,
    snippet: "fixture source line result",
    source: "memory" as const,
    citation: "MEMORY.md:12-14",
    metadata: sharedSkwMetadata,
    ...patch,
  };
}

describe("memory generic tools SKW metadata", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
    memoryToolsTesting.resetMemorySearchToolCooldowns();
  });

  it("keeps QMD memory_search output byte-identical when no SKW metadata is present", async () => {
    // Given: the generic tool is driven through a QMD-style manager result.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    setMemoryBackend("qmd");
    setMemorySearchImpl(async (opts) => {
      opts?.onDebug?.({ backend: "qmd", configuredMode: "query", effectiveMode: "query" });
      return [
        {
          path: "qmd://memory/MEMORY.md:12-14",
          startLine: 12,
          endLine: 14,
          score: 0.97,
          snippet: "fixture source line result",
          source: "memory" as const,
        },
      ];
    });
    const tool = createMemorySearchToolOrThrow({
      config: { memory: { backend: "qmd" }, agents: { list: [{ id: "main", default: true }] } },
    });

    // When: memory_search serializes the hit.
    const result = await tool.execute("qmd-baseline", { query: "fixture" });
    nowSpy.mockRestore();

    // Then: the byte surface stays exactly the legacy QMD shape.
    expect(JSON.stringify(result.details)).toBe(
      '{"results":[{"path":"qmd://memory/MEMORY.md:12-14","startLine":12,"endLine":14,"score":0.97,"snippet":"fixture source line result\\n\\nSource: qmd://memory/MEMORY.md:12-14#L12-L14","source":"memory","citation":"qmd://memory/MEMORY.md:12-14#L12-L14","corpus":"memory"}],"provider":"builtin","model":"builtin","citations":"auto","mode":"query","debug":{"backend":"qmd","configuredMode":"query","effectiveMode":"query","searchMs":0,"hits":1}}',
    );
  });

  it("keeps builtin memory_get output byte-identical when no SKW metadata is present", async () => {
    // Given: the generic get tool is driven through the builtin direct read path.
    setMemoryBackend("builtin");
    setMemoryReadFileImpl(async (params) => ({
      path: params.relPath,
      text: "fixture source line result",
      from: params.from ?? 12,
      lines: params.lines ?? 3,
    }));
    const tool = createMemoryGetToolOrThrow();

    // When: memory_get reads the legacy path.
    const result = await tool.execute("builtin-baseline", {
      path: "memory/source-file-line.md",
      from: 12,
      lines: 3,
    });

    // Then: the byte surface stays exactly the legacy builtin shape.
    expect(JSON.stringify(result.details)).toBe(
      '{"path":"memory/source-file-line.md","text":"fixture source line result","from":12,"lines":3}',
    );
  });

  it("carries shared SKW metadata through memory_search byte-for-byte", async () => {
    // Given: SKW returns provider metadata next to the signed read path.
    setMemoryBackend("skw");
    setMemorySearchImpl(async () => [skwSearchHit()]);
    const tool = createMemorySearchToolOrThrow({
      config: {
        memory: { backend: "skw", citations: "off" },
        agents: { list: [{ id: "main", default: true }] },
      },
    });

    // When: memory_search serializes the hit for generic tool consumers.
    const result = await tool.execute("skw-metadata", { query: "fixture" });

    // Then: path remains signed and the shared-SKW metadata shape is preserved exactly.
    expect(result.details).toEqual({
      results: [
        {
          path: signedPath,
          startLine: 12,
          endLine: 14,
          score: 0.97,
          snippet: "fixture source line result",
          source: "memory",
          citation: undefined,
          corpus: "memory",
          metadata: sharedSkwMetadata,
        },
      ],
      provider: "builtin",
      model: "builtin",
      fallback: undefined,
      citations: "off",
      mode: undefined,
      debug: {
        backend: "skw",
        configuredMode: undefined,
        effectiveMode: "n/a",
        fallback: undefined,
        hits: 1,
        searchMs: expect.any(Number),
      },
    });
    expect(searchMetadataJson(result.details)).toBe(JSON.stringify(sharedSkwMetadata));
  });

  it("carries shared SKW metadata through memory_get byte-for-byte", async () => {
    // Given: SKW read returns provider metadata for the signed path.
    setMemoryBackend("skw");
    setMemoryReadFileImpl(async (params) => ({
      path: params.relPath,
      text: "fixture source line result",
      from: params.from ?? 12,
      lines: params.lines ?? 3,
      metadata: sharedSkwMetadata,
    }));
    const tool = createMemoryGetToolOrThrow({
      memory: { backend: "skw" },
      agents: { list: [{ id: "main", default: true }] },
    });

    // When: memory_get reads the signed SKW path.
    const result = await tool.execute("skw-get-metadata", { path: signedPath, from: 12, lines: 3 });

    // Then: read metadata is typed and displayPath stays separate from the signed path.
    expect(result.details).toEqual({
      path: signedPath,
      text: "fixture source line result",
      from: 12,
      lines: 3,
      metadata: sharedSkwMetadata,
    });
    expect(readMetadataJson(result.details)).toBe(JSON.stringify(sharedSkwMetadata));
  });

  it.each([
    ...["verified", "observed", "derived"].map((truthTier) => ({
      name: `old truth tier ${truthTier}`,
      patch: { metadata: { ...sharedSkwMetadata, truthTier } },
      error: "skw metadata truthTier is invalid",
    })),
    {
      name: "invalid truth tier",
      patch: { metadata: { ...sharedSkwMetadata, truthTier: "rumor" } },
      error: "skw metadata truthTier is invalid",
    },
    {
      name: "old visibility vocabulary",
      patch: { metadata: { ...sharedSkwMetadata, visibility: "shared_accepted" } },
      error: "skw metadata visibility is invalid",
    },
    {
      name: "invalid collection",
      patch: { metadata: { ...sharedSkwMetadata, collection: "../private" } },
      error: "skw metadata collection is invalid",
    },
    {
      name: "hidden proposal",
      patch: { metadata: { ...sharedSkwMetadata, visibility: "hidden_proposal" } },
      error: "skw metadata visibility is invalid",
    },
    {
      name: "invalid handle",
      patch: { metadata: { ...sharedSkwMetadata, handles: ["memory:ok", "../raw"] } },
      error: "skw metadata handle is invalid",
    },
  ] satisfies readonly InvalidMetadataCase[])(
    "fails closed for $name",
    async ({ patch, error }) => {
      // Given: SKW returns a hit with untrusted metadata.
      setMemoryBackend("skw");
      setMemorySearchImpl(async () => [skwSearchHit(patch)]);
      const tool = createMemorySearchToolOrThrow({
        config: { memory: { backend: "skw" }, agents: { list: [{ id: "main", default: true }] } },
      });

      // When: memory_search serializes provider output.
      const result = await tool.execute("skw-invalid-metadata", { query: "fixture" });

      // Then: the invalid hit is not surfaced to generic tool consumers.
      expect(result.details).toEqual(expect.objectContaining({ disabled: true, error }));
    },
  );

  it.each(invalidSkwReadPathCases)(
    "fails closed for $name SKW memory_get paths",
    async ({ path }) => {
      // Given: SKW is active but the path is not a non-empty v1 opaque handle.
      setMemoryBackend("skw");
      const tool = createMemoryGetToolOrThrow({
        memory: { backend: "skw" },
        agents: { list: [{ id: "main", default: true }] },
      });

      // When: memory_get receives an invalid skw:// path.
      const result = await tool.execute("skw-get-invalid-handle", { path });

      // Then: it fails closed before manager reads.
      expect(result.details).toEqual({
        path,
        text: "",
        disabled: true,
        error: "skw memory backend requires a skw://v1/<opaque-token> read handle",
      });
    },
  );
});
