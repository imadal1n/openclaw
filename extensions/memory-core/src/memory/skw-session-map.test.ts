import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_ID, createSkwConfig } from "./__fixtures__/skw/skw-manager-test-harness.js";
import { createSkwSessionMappingProvider } from "./skw-session-map.js";

const SESSION_A_KEY = `agent:${AGENT_ID}:direct:a`;
const SESSION_B_KEY = `agent:${AGENT_ID}:direct:b`;
const tempDirs: string[] = [];

function writeSessionStore(
  store: Record<string, { readonly sessionId: string; readonly updatedAt: number }>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skw-session-map-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
  return storePath;
}

describe("createSkwSessionMappingProvider", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds same-agent canonical sessionId and sessionKey mappings", () => {
    // Given: a gateway session store contains two sessions for this agent and one other-agent row.
    const storePath = writeSessionStore({
      "direct:a": { sessionId: "session-a", updatedAt: 1 },
      "direct:b": { sessionId: "session-b", updatedAt: 2 },
      "agent:other:direct:c": { sessionId: "session-c", updatedAt: 3 },
    });
    const cfg = { ...createSkwConfig(AGENT_ID), session: { store: storePath } };
    const provider = createSkwSessionMappingProvider({ cfg, agentId: AGENT_ID });

    // When: SKW asks for session-corpus scope for the current session key.
    const scope = provider.resolveSessionScope({
      agentId: AGENT_ID,
      sessionKey: SESSION_A_KEY,
      sources: ["sessions"],
    });

    // Then: the provider emits canonical, provider-neutral transcript identities.
    expect(scope).toMatchObject({
      sessionKey: SESSION_A_KEY,
      sources: ["sessions"],
      mappings: [
        expect.objectContaining({ sessionId: "session-a", sessionKey: SESSION_A_KEY }),
        expect.objectContaining({ sessionId: "session-b", sessionKey: SESSION_B_KEY }),
      ],
    });
    expect(scope?.mappings).toHaveLength(2);
  });
});

export {};
