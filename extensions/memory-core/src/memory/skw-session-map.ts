import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  buildSessionTranscriptMapEntry,
  loadCombinedSessionStoreForGateway,
} from "openclaw/plugin-sdk/session-transcript-hit";
import type { SkwSessionMappingProvider, SkwSessionScope } from "./skw-manager.js";

function normalizeRequestedSources(
  sources: readonly string[] | undefined,
): readonly MemorySource[] {
  const requested = sources?.filter((source): source is MemorySource => {
    return source === "memory" || source === "sessions";
  });
  return requested && requested.length > 0 ? requested : ["sessions"];
}

function sameAgentSessionKey(sessionKey: string, agentId: string): boolean {
  return normalizeAgentId(resolveAgentIdFromSessionKey(sessionKey)) === agentId;
}

export function createSkwSessionMappingProvider(params: {
  readonly cfg: OpenClawConfig;
  readonly agentId: string;
}): SkwSessionMappingProvider {
  const agentId = normalizeAgentId(params.agentId);
  return {
    resolveSessionScope(scopeParams): SkwSessionScope | null {
      if (normalizeAgentId(scopeParams.agentId) !== agentId) {
        return null;
      }
      const sources = normalizeRequestedSources(scopeParams.sources);
      if (!sources.includes("sessions")) {
        return null;
      }
      const sessionKey = scopeParams.sessionKey?.trim();
      if (!sessionKey || !sameAgentSessionKey(sessionKey, agentId)) {
        return null;
      }
      const { store } = loadCombinedSessionStoreForGateway(params.cfg, { agentId });
      if (!store[sessionKey]?.sessionId?.trim()) {
        return null;
      }
      const mappings = Object.entries(store)
        .filter(
          ([key, entry]) => sameAgentSessionKey(key, agentId) && Boolean(entry.sessionId?.trim()),
        )
        .map(([key, entry]) =>
          buildSessionTranscriptMapEntry({
            agentId,
            sessionId: entry.sessionId,
            sessionKey: key,
          }),
        );
      return mappings.length > 0 ? { sessionKey, sources: [...sources], mappings } : null;
    },
  };
}

export {};
