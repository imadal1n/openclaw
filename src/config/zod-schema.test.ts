// Tests for the new memory SKW Zod schemas.
import { describe, expect, it } from "vitest";
import {
  MemoryAgentBackendSchema,
  MemorySkwSchema,
  SkwProfileDefinitionSchema,
} from "./zod-schema.js";

const validProfileDefinition = {
  databasePath: "/nix/db.sqlite",
  memoryDatabasePath: "/nix/memory.sqlite",
  sessionMapPath: "/nix/session.json",
  cachePath: "/nix/cache",
  allowedCollections: ["default"],
  allowedSourceRoots: ["/nix/sources"],
  limits: {
    recallMode: "hybrid" as const,
    topK: 10,
    writable: true,
    autoExtract: true,
    extractor: "llm" as const,
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
};

describe("MemoryAgentBackendSchema", () => {
  it("accepts a valid per-agent skw override", () => {
    const result = MemoryAgentBackendSchema.safeParse({
      backend: "skw",
      skw: { profile: "main-profile", writable: true, autoExtract: false, prefetch: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty per-agent override", () => {
    const result = MemoryAgentBackendSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects caller-supplied path keys in agent skw override", () => {
    const result = MemoryAgentBackendSchema.safeParse({
      backend: "skw",
      skw: {
        profile: "main-profile",
        databasePath: "/evil/db.sqlite",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid backend literal", () => {
    const result = MemoryAgentBackendSchema.safeParse({
      backend: "custom-backend",
    });
    expect(result.success).toBe(false);
  });
});

describe("SkwProfileDefinitionSchema", () => {
  it("accepts a valid profile definition with all Nix-owned paths", () => {
    const result = SkwProfileDefinitionSchema.safeParse(validProfileDefinition);
    expect(result.success).toBe(true);
  });

  it("rejects a profile definition missing a Nix-owned path", () => {
    const result = SkwProfileDefinitionSchema.safeParse({
      ...validProfileDefinition,
      memoryDatabasePath: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("rejects caller-supplied limits outside the declared schema", () => {
    const result = SkwProfileDefinitionSchema.safeParse({
      ...validProfileDefinition,
      limits: {
        ...validProfileDefinition.limits,
        extraLimit: 123,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("MemorySkwSchema", () => {
  it("accepts valid profile definitions and legacy profiles", () => {
    const result = MemorySkwSchema.safeParse({
      profiles: { main: "main-profile" },
      profileDefinitions: {
        "main-profile": validProfileDefinition,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an undeclared profile definition shape", () => {
    const result = MemorySkwSchema.safeParse({
      profileDefinitions: {
        "main-profile": {
          databasePath: "/nix/db.sqlite",
          memoryDatabasePath: "/nix/memory.sqlite",
          sessionMapPath: "/nix/session.json",
          cachePath: "/nix/cache",
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
