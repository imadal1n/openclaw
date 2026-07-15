import process from "node:process";

// Long-lived fake SKW provider for process-lane tests.
// Behavior is controlled by the incoming `op` field and by FAKE_CHILD_* env vars.

const ignoreTerm = process.env.FAKE_CHILD_IGNORE_TERM === "1";
const startupNoise = process.env.FAKE_CHILD_STARTUP_NOISE === "1";
const neverRead = process.env.FAKE_CHILD_NEVER_READ === "1";
const shutdownHang = process.env.FAKE_CHILD_SHUTDOWN_HANG === "1";
const exitOnStartup = process.env.FAKE_CHILD_EXIT_ON_STARTUP
  ? Number.parseInt(process.env.FAKE_CHILD_EXIT_ON_STARTUP, 10)
  : null;

if (ignoreTerm) {
  process.on("SIGTERM", () => {
    // Deliberately ignore to force KILL escalation.
  });
}

if (typeof exitOnStartup === "number" && !Number.isNaN(exitOnStartup)) {
  process.exit(exitOnStartup);
}

if (startupNoise) {
  process.stdout.write("unsolicited stdout noise\n");
}

if (neverRead) {
  // Keep the process alive but never consume stdin, so the parent sees backpressure.
  setInterval(() => {}, 60_000);
} else {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) {
        continue;
      }
      try {
        handleFrame(JSON.parse(line));
      } catch (err) {
        process.stderr.write(`parse error: ${err.message}\n`);
        process.exit(1);
      }
    }
  });

  process.stdin.on("end", () => {
    if (buffer.length > 0) {
      process.stderr.write("partial frame at EOF\n");
      process.exit(1);
    }
    process.exit(0);
  });

  process.stdin.on("error", (err) => {
    process.stderr.write(`stdin error: ${err.message}\n`);
    process.exit(1);
  });
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handleFrame(frame) {
  const id = typeof frame.id === "string" ? frame.id : "missing";
  const op = typeof frame.op === "string" ? frame.op : "unknown";

  if (op === "hang") {
    return;
  }

  if (op === "crash") {
    process.exit(1);
  }

  if (op === "error") {
    send({ version: 1, id, ok: false, error: { code: "DENIED", message: "profile denied" } });
    return;
  }

  if (op === "error-unknown-code") {
    send({ version: 1, id, ok: false, error: { code: "NOT_A_CODE", message: "unknown code" } });
    return;
  }

  if (op === "partial") {
    process.stdout.write(JSON.stringify({ version: 1, id }));
    return;
  }

  if (op === "oversized") {
    const big = "x".repeat(2 * 1024 * 1024);
    send({ version: 1, id, ok: true, result: { data: big } });
    return;
  }

  if (op === "unknown-field") {
    send({ version: 1, id, ok: true, result: {}, extra: "bad" });
    return;
  }

  if (op === "unknown-error-field") {
    send({ version: 1, id, ok: false, error: { code: "DENIED", message: "denied", extra: "bad" } });
    return;
  }

  if (op === "mixed-envelope") {
    send({ version: 1, id, ok: true, result: {}, error: { code: "INTERNAL", message: "mixed" } });
    return;
  }

  if (op === "error-with-result") {
    send({
      version: 1,
      id,
      ok: false,
      result: { leaked: true },
      error: { code: "INTERNAL", message: "leak" },
    });
    return;
  }

  if (op === "wrong-version") {
    send({ version: 2, id, ok: true, result: {} });
    return;
  }

  if (op === "wrong-id") {
    send({ version: 1, id: "wrong-id", ok: true, result: {} });
    return;
  }

  if (op === "duplicate") {
    send({ version: 1, id, ok: true, result: { first: true } });
    send({ version: 1, id, ok: true, result: { second: true } });
    return;
  }

  if (op === "shutdown") {
    if (shutdownHang) {
      return;
    }
    send({ version: 1, id, ok: true, result: { ok: true } });
    process.exit(0);
  }

  if (op === "slow") {
    setTimeout(() => {
      send({ version: 1, id, ok: true, result: { delayed: true } });
    }, 2_000);
    return;
  }

  if (op === "env") {
    send({
      version: 1,
      id,
      ok: true,
      result: {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.startsWith("TEST_ECHO_")),
        ),
      },
    });
    return;
  }

  send({ version: 1, id, ok: true, result: { op, received: frame.params } });
}
