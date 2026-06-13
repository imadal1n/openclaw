import { beforeEach, describe, expect, it } from "vitest";
import {
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "./diagnostic-run-activity.js";
import {
  requestStuckSessionRecovery,
  resetDiagnosticSessionRecoveryCoordinatorForTest,
} from "./diagnostic-session-recovery-coordinator.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";

describe("diagnostic session recovery coordinator", () => {
  beforeEach(() => {
    resetDiagnosticSessionRecoveryCoordinatorForTest();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticSessionStateForTest();
  });

  it("idles a session with queued work when an aborted run leaves a fresh embedded handle", () => {
    const sessionId = "session-queued-recovery";
    const sessionKey = "peer:+40729991311";

    // Pre-recovery active run (the one recovery will abort).
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, workKey: "stale-run" });

    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.state = "processing";
    state.queueDepth = 1;

    requestStuckSessionRecovery({
      recover: () => {
        // Simulate a new handle appearing from the queued turn while recovery awaited.
        markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, workKey: "fresh-run" });
        return {
          status: "aborted",
          action: "abort_embedded_run",
          sessionId,
          sessionKey,
          activeSessionId: sessionId,
          activeWorkKind: "embedded_run",
          aborted: true,
          drained: true,
          forceCleared: false,
          released: 0,
          queuedCount: 0,
        };
      },
      request: {
        sessionId,
        sessionKey,
        ageMs: 30000,
        queueDepth: 1,
        allowActiveAbort: true,
        expectedState: "processing",
        stateGeneration: 0,
      },
      classification: {
        eventType: "session.stuck",
        reason: "stuck_processing",
        classification: "stale_session_state",
        recoveryEligible: true,
      },
    });

    expect(state.state).toBe("idle");
    expect(state.queueDepth).toBe(1);
  });
});
