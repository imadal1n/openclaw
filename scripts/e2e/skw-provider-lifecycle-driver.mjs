#!/usr/bin/env node
// OpenClaw SKW provider lifecycle driver using the real SkwMemorySearchManager.
import { parseArgs } from "node:util";
import {
  buildManagerConfig,
  buildMemoryKey,
  defaultProviderCommand,
  makeSessionMappingProvider,
  parseProviderCommand,
  prepareFixture,
} from "./lib/skw-provider-lifecycle-driver/fixture.mjs";
import {
  runLifecycle,
  LifecycleError,
  printOutcomes,
} from "./lib/skw-provider-lifecycle-driver/lifecycle.mjs";
import { isProcessAlive } from "./lib/skw-provider-lifecycle-driver/process-lifecycle.mjs";

const options = {
  "provider-command": { type: "string" },
  fixture: { type: "string" },
  "state-dir": { type: "string" },
  "expect-all-operations": { type: "boolean", default: false },
  "request-timeout-ms": { type: "string", default: "30000" },
  help: { type: "boolean", default: false },
};

function usage() {
  return `Usage: node --import tsx scripts/e2e/skw-provider-lifecycle-driver.mjs [options]

Options:
  --provider-command <cmd>    Provider argv string (default: shared venv python -m skw.openclaw_provider)
  --fixture <path>            Prebuilt state-root directory containing skw.sqlite3 and skw-memory.sqlite3
  --state-dir <path>          Isolated state directory; created if absent and --fixture not given
  --expect-all-operations     Exit non-zero if any lifecycle check fails
  --request-timeout-ms <n>    Per-request timeout (default: 30000)
  --help                      Show this help
`;
}

async function main() {
  const { values } = parseArgs({ options, allowPositionals: true, strict: false });
  if (values.help) {
    process.stdout.write(usage());
    return 0;
  }

  const requestTimeoutMs = Number(values["request-timeout-ms"] ?? "30000");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new DriverError(`invalid request timeout: ${String(values["request-timeout-ms"])}`);
  }

  const providerCommand = values["provider-command"]
    ? parseProviderCommand(values["provider-command"])
    : defaultProviderCommand();
  if (providerCommand.length === 0) {
    throw new DriverError("provider command is empty");
  }

  const { stateDir, created } = values.fixture
    ? { stateDir: prepareFixture(values.fixture).stateDir, created: false }
    : values["state-dir"]
      ? { stateDir: values["state-dir"], created: false }
      : prepareFixture();

  const providerEnv = {
    HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    FAKE_PROVIDER_JOURNAL_PATH: stateDir + "/fake-provider-journal.jsonl",
    PATH: process.env.PATH ?? "",
  };

  const { cfg, resolved } = buildManagerConfig(
    providerCommand,
    stateDir,
    "todo10-agent",
    "fixture",
    requestTimeoutMs,
    providerEnv,
  );

  // Resolve the real manager modules from TypeScript source via tsx.
  const [{ SkwMemorySearchManager }, { skwProviderPool }] = await Promise.all([
    import("../../extensions/memory-core/src/memory/skw-manager.ts"),
    import("../../extensions/memory-core/src/memory/skw-provider-pool.ts"),
  ]);

  const sessionId = "todo10-session";
  const sessionKey = "todo10-key";
  const nextSessionId = "todo10-session-next";
  const nextSessionKey = "todo10-key-next";
  const memoryKey = buildMemoryKey("todo10-agent", sessionId);
  const nextMemoryKey = buildMemoryKey("todo10-agent", nextSessionId);
  const sessionMappingProvider = makeSessionMappingProvider("todo10-agent", "fixture", [
    { sessionId, sessionKey, memoryKey },
    { sessionId: nextSessionId, sessionKey: nextSessionKey, memoryKey: nextMemoryKey },
  ]);

  const manager = await SkwMemorySearchManager.create({
    cfg,
    agentId: "todo10-agent",
    resolved,
    sessionMappingProvider,
  });
  if (!manager) {
    throw new DriverError("SkwMemorySearchManager.create returned null");
  }

  let result;
  let childPid = manager.process?.child?.pid ?? null;
  try {
    result = await runLifecycle({
      manager,
      stateDir,
      expectAllOperations: values["expect-all-operations"] === true,
    });
  } finally {
    await manager.close().catch(() => undefined);
    await skwProviderPool.closeAll().catch(() => undefined);
  }

  // The manager owns the process through the pool; verify it is gone after close.
  const noChildAfterClose = childPid ? !isProcessAlive(childPid) : true;
  if (!noChildAfterClose) {
    throw new DriverError(`provider child PID ${String(childPid)} still alive after close`);
  }

  if (values["expect-all-operations"] === true) {
    printOutcomes(result.outcomes, process.stderr);
    if (!result.allPassed) {
      throw new DriverError("one or more lifecycle checks failed", result.outcomes);
    }
  }

  process.stdout.write(
    JSON.stringify({ stateDir, created, pid: childPid, allPassed: result.allPassed }, null, 2) +
      "\n",
  );
  return 0;
}

class DriverError extends Error {
  /**
   * @param {string} message
   * @param {import("./lib/skw-provider-lifecycle-driver/lifecycle.mjs").Outcome[] | undefined} outcomes
   */
  constructor(message, outcomes) {
    super(message);
    this.name = "DriverError";
    this.outcomes = outcomes;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof LifecycleError) {
      printOutcomes(error.outcomes, process.stderr);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
