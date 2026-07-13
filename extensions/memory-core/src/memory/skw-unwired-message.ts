// Memory Core SKW backend inactive/fail-closed message.
// This message is intentionally shared across manager and tool surfaces so
// tests and debugging have a single named constant to assert, while the
// public tool results continue to expose only the stable string.
export const SKW_MEMORY_ADAPTER_UNWIRED =
  "skw memory backend is configured but no SKW adapter is wired; QMD remains the supported source/startup backend until SKW cutover is approved";
