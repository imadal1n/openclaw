import { describe, expect, it } from "vitest";
import {
  buildSessionTranscriptMapEntry,
  formatSessionTranscriptMemoryHitKey,
} from "./session-transcript-memory-hit.js";

describe("buildSessionTranscriptMapEntry", () => {
  it("builds a provider-neutral session map entry from canonical session identity", () => {
    // Given: a session has a raw provider session id and an OpenClaw session key.
    const sessionId = "provider:session/1";
    const sessionKey = "agent:main:matrix:channel:room";

    // When: the mapping entry is built for a provider session map.
    const entry = buildSessionTranscriptMapEntry({
      agentId: "MAIN",
      sessionId,
      sessionKey,
    });

    // Then: the provider-neutral entry keeps both identities and uses the key as source id.
    expect(entry).toEqual({
      agentId: "main",
      archived: false,
      memoryKey: formatSessionTranscriptMemoryHitKey({ agentId: "main", sessionId }),
      sessionId,
      sessionKey,
      sourceId: sessionKey,
    });
  });

  it("rejects entries without a canonical session key", () => {
    // Given: an otherwise valid transcript identity is missing the OpenClaw session key.
    const params = {
      agentId: "main",
      sessionId: "provider-session",
      sessionKey: " ",
    };

    // When / Then: construction fails before a provider can receive an ambiguous map row.
    expect(() => buildSessionTranscriptMapEntry(params)).toThrow(/sessionKey/);
  });
});

export {};
