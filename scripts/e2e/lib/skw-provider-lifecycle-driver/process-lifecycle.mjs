// Provider child lifecycle helpers (termination, exit-wait, liveness).

const CHILD_EXIT_TIMEOUT_MS = 5000;

/**
 * Terminate the provider child by SIGTERM then SIGKILL.
 * @param {object} provider
 * @param {import("node:child_process").ChildProcess} provider.child
 * @param {boolean} provider.closing
 * @param {boolean} provider.closed
 * @param {number} [timeoutMs]
 * @returns {Promise<{code: number | null; signal: string | null}>}
 */
export function terminate(provider, timeoutMs = CHILD_EXIT_TIMEOUT_MS) {
  provider.closing = true;
  const child = provider.child;
  return new Promise((resolve) => {
    let settled = false;
    let sigkillTimer;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
      provider.closed = true;
      try {
        child.stdin?.end?.();
      } catch {}
      resolve({ code, signal: signal ?? null });
    };
    const sigtermTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      sigkillTimer = setTimeout(() => finish(null, "SIGKILL"), 5000);
    }, timeoutMs);
    child.once("exit", (code, signal) => finish(code, signal ?? null));
    child.once("error", () => finish(null, "SIGTERM"));
    try {
      child.stdin?.end?.();
    } catch {}
    try {
      child.kill("SIGTERM");
    } catch {}
  });
}

/**
 * Wait for the provider child to exit without sending a signal.
 * @param {object} provider
 * @param {import("node:child_process").ChildProcess} provider.child
 * @param {boolean} provider.closed
 * @param {number} [timeoutMs]
 * @returns {Promise<{code: number | null; signal: string | null}>}
 */
export function waitForExit(provider, timeoutMs = CHILD_EXIT_TIMEOUT_MS) {
  const child = provider.child;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      provider.closed = true;
      resolve({ code, signal: signal ?? null });
    };
    const timer = setTimeout(() => finish(null, "timeout"), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish(code, signal ?? null);
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish(null, "SIGTERM");
    });
    if (child.exitCode !== null) {
      clearTimeout(timer);
      finish(child.exitCode, child.signalCode ?? null);
    }
  });
}

/**
 * Verify the provider process is no longer running.
 * @param {number | undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (pid === undefined || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
