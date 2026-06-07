// Memory Wiki tests cover lint plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintMemoryWikiVault } from "./lint.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("lintMemoryWikiVault", () => {
  it("accepts native markdown links that include the relative .md target", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-native-links-",
      config: {
        vault: { renderMode: "native" },
      },
    });
    await Promise.all(
      ["entities", "sources"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
        },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
        },
        body: "# Alpha\n\n[Alpha Source](sources/alpha.md)\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.map((issue) => issue.code)).not.toContain("broken-wikilink");
  });

  it("detects duplicate ids, provenance gaps, contradictions, and open questions", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["entities", "concepts", "sources", "syntheses"].map((dir) =>
        fs.mkdir(path.join(rootDir, dir), { recursive: true }),
      ),
    );

    const duplicate = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        contradictions: ["Conflicts with source.beta"],
        questions: ["Is Alpha still active?"],
        confidence: 0.2,
        claims: [
          {
            id: "claim.alpha.db",
            text: "Alpha uses PostgreSQL for production writes.",
            confidence: 0.2,
            evidence: [],
          },
        ],
      },
      body: "# Alpha\n\n[[missing-page]]\n",
    });
    await fs.writeFile(path.join(rootDir, "entities", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(path.join(rootDir, "concepts", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.alpha",
          title: "Bridge Alpha",
          sourceType: "memory-bridge",
        },
        body: "# Bridge Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-db.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.alpha.db",
          title: "Alpha Database",
          sourceIds: ["source.bridge.alpha"],
          updatedAt: "2025-10-01T00:00:00.000Z",
          claims: [
            {
              id: "claim.alpha.db",
              text: "Alpha uses MySQL for production writes.",
              status: "contested",
              confidence: 0.7,
              evidence: [
                {
                  sourceId: "source.bridge.alpha",
                  lines: "1-3",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        body: "# Alpha Database\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issueCount).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate-id");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-source-ids");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-import-provenance");
    expect(result.issues.map((issue) => issue.code)).toContain("broken-wikilink");
    expect(result.issues.map((issue) => issue.code)).toContain("contradiction-present");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-conflict");
    expect(result.issues.map((issue) => issue.code)).toContain("open-question");
    expect(result.issues.map((issue) => issue.code)).toContain("low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-missing-evidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-page");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-claim");
    expect(result.issuesByCategory.contradictions.map((issue) => issue.code)).toContain(
      "claim-conflict",
    );
    expect(result.issuesByCategory["open-questions"].length).toBeGreaterThanOrEqual(2);
    expect(result.issuesByCategory.provenance.map((issue) => issue.code)).toContain(
      "missing-import-provenance",
    );
    expect(result.issuesByCategory.provenance.map((issue) => issue.code)).toContain(
      "claim-missing-evidence",
    );
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Errors");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Contradictions");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Open Questions");
  });

  it("does not emit stale-page warnings for immutable imported source pages", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-imported-source-freshness-",
      config: {
        vault: { renderMode: "native" },
      },
    });
    await Promise.all(
      ["sources", "syntheses"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );

    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-stale.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.stale",
          title: "Bridge Stale",
          sourceType: "memory-bridge",
          sourcePath: "memory/daily/2026-03-07.md",
          bridgeRelativePath: "memory/daily/2026-03-07.md",
          bridgeWorkspaceDir: "main",
          updatedAt: "2025-10-01T00:00:00.000Z",
        },
        body: "# Bridge Stale\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-events-unknown.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.events.unknown",
          title: "Bridge Events Unknown",
          sourceType: "memory-bridge-events",
          sourcePath: "memory/events.jsonl",
          bridgeRelativePath: "memory/events.jsonl",
          bridgeWorkspaceDir: "main",
        },
        body: "# Bridge Events Unknown\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe-stale.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.unsafe.stale",
          title: "Unsafe Stale",
          sourceType: "memory-unsafe-local",
          provenanceMode: "unsafe-local",
          sourcePath: "/home/limax/openclaw-workspace/memory/daily/2026-03-08.md",
          unsafeLocalConfiguredPath: "/home/limax/openclaw-workspace/memory",
          unsafeLocalRelativePath: "daily/2026-03-08.md",
          updatedAt: "2025-10-01T00:00:00.000Z",
        },
        body: "# Unsafe Stale\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe-mode-unknown.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.unsafe.mode.unknown",
          title: "Unsafe Mode Unknown",
          sourcePath: "/home/limax/openclaw-workspace/memory/context/CONTEXT.md",
          unsafeLocalConfiguredPath: "/home/limax/openclaw-workspace/memory",
          unsafeLocalRelativePath: "context/CONTEXT.md",
          provenanceMode: "unsafe-local",
        },
        body: "# Unsafe Mode Unknown\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "stale-maintained.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.stale.maintained",
          title: "Stale Maintained",
          sourceIds: ["source.bridge.stale"],
          updatedAt: "2025-10-01T00:00:00.000Z",
        },
        body: "# Stale Maintained\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);
    const stalePagePaths = result.issues
      .filter((issue) => issue.code === "stale-page")
      .map((issue) => issue.path)
      .toSorted();

    expect(stalePagePaths).toContain("syntheses/stale-maintained.md");
    expect(stalePagePaths).not.toContain("sources/bridge-stale.md");
    expect(stalePagePaths).not.toContain("sources/bridge-events-unknown.md");
    expect(stalePagePaths).not.toContain("sources/unsafe-stale.md");
    expect(stalePagePaths).not.toContain("sources/unsafe-mode-unknown.md");
  });
});
