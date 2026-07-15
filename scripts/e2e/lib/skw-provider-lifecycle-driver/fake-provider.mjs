#!/usr/bin/env node
// Fake strict OpenClaw SKW provider for lifecycle driver tests.
import { stdin } from "node:process";
import { respond } from "./fake-provider-respond.mjs";

const config = {
  mode: process.env.FAKE_PROVIDER_MODE ?? "strict",
  faultOp: process.env.FAKE_PROVIDER_FAULT_OP ?? "",
  faultDelayMs: Number(process.env.FAKE_PROVIDER_FAULT_DELAY_MS ?? "3000"),
  faultText: process.env.FAKE_PROVIDER_FAULT_TEXT ?? "",
  journalPath: process.env.FAKE_PROVIDER_JOURNAL_PATH ?? "",
};

const state = {
  sessions: new Map(),
  sessionsByKey: new Map(),
  idempotency: new Map(),
  initParams: undefined,
  FAULT_TEXT: config.faultText,
};

// Seed the initial session. Strict mode updates this on endSession; other modes
// manipulate the maps to simulate cross-session or misleading-success violations.
state.sessions.set("todo10-session", "todo10-key");
state.sessionsByKey.set("todo10-key", "todo10-session");

let buffer = "";

stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      handleFrame(trimmed);
    }
  }
});

stdin.on("end", () => {
  if (buffer.trim()) {
    handleFrame(buffer.trim());
  }
});

process.on("SIGTERM", () => {
  if (config.mode === "sigint" || config.mode === "no-close") {
    // Stay alive until SIGKILL.
    return;
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  if (config.mode === "sigint") {
    process.exit(130);
  }
  process.exit(0);
});

function handleFrame(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeError("", "invalid JSON");
    process.exit(1);
  }
  const id = request.id;
  const op = request.op;
  const identity = request.identity ?? {};

  if (config.mode === "malformed" && matchesFaultOp(op)) {
    process.stdout.write("{not valid json\n");
    return;
  }
  if (config.mode === "crash" && matchesFaultOp(op)) {
    process.exit(42);
  }
  if (config.mode === "timeout" && matchesFaultOp(op)) {
    // Never respond; the manager will time out.
    return;
  }
  if (config.mode === "late" && matchesFaultOp(op)) {
    setTimeout(
      () => respond({ config, op, id, identity, params: request.params, state }),
      config.faultDelayMs,
    );
    return;
  }
  if (config.mode === "duplicate" && matchesFaultOp(op)) {
    process.stderr.write("duplicate response detected\n");
    respond({ config, op, id, identity, params: request.params, state });
    respond({ config, op, id, identity, params: request.params, state });
    return;
  }
  respond({ config, op, id, identity, params: request.params, state });
}

function matchesFaultOp(op) {
  return config.faultOp === "" || config.faultOp === op;
}

function writeError(id, message) {
  const response = {
    version: 1,
    id,
    ok: false,
    error: { code: "MALFORMED_OUTPUT", message },
  };
  process.stdout.write(JSON.stringify(response) + "\n");
}
