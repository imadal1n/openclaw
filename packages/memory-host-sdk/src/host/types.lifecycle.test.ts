// Tests for the lifecycle-shaped ResolvedSkwConfig type.
import { describe, expect, it } from "vitest";
import type { ResolvedSkwConfig } from "./backend-config.js";

describe("ResolvedSkwConfig lifecycle fields", () => {
  it("accepts profile, profileDefinition, and effective policy", () => {
    const resolved: ResolvedSkwConfig = {
      profiles: { main: "main-profile" },
      profile: "main-profile",
      profileDefinition: {
        databasePath: "/nix/db.sqlite",
        memoryDatabasePath: "/nix/memory.sqlite",
        sessionMapPath: "/nix/session.json",
        cachePath: "/nix/cache",
        allowedCollections: [],
        allowedSourceRoots: [],
        limits: {
          recallMode: "hybrid",
          topK: 10,
          writable: true,
          autoExtract: true,
          extractor: "llm",
          maxWriteCharacters: 1000,
          maxInjectedCharacters: 2000,
          maxInjectedTokens: 500,
          minTurnsBetweenAttempts: 1,
          candidatePoolSize: 20,
          rerankThreshold: 0.5,
          maxChunksPerSource: 3,
          defaultTrust: 0.8,
          minTrust: 0.2,
          temporalDecayHalfLife: 24,
          rerankerModel: "default",
          rerankerCacheDir: "/tmp",
        },
      },
      effective: {
        writable: false,
        autoExtract: true,
        prefetch: true,
      },
    };
    expect(resolved.profile).toBe("main-profile");
    expect(resolved.profileDefinition?.limits.writable).toBe(true);
    expect(resolved.effective?.writable).toBe(false);
  });
});
