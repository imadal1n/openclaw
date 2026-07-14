// I/O helpers and child lifecycle for the persistent SKW provider process.
import {
  isValidUtf8,
  KILL_ESCALATION_MS,
  MAX_FRAME_BYTES,
  SkwProviderError,
  type SkwWireResult,
  validateWireResponse,
  STDERR_RING_BYTES,
} from "./skw-provider-framing.js";
import type { SkwProviderProcess } from "./skw-provider-process.js";

export type ChildExit = { code: number | null; signal: string | null };

export function spawnChild(process: SkwProviderProcess): void {
  process.state = "starting";
  process.restartPending = false;
  clearKillTimer(process);
  process.stdoutBuffer = Buffer.alloc(0);
  process.stderrBuffer = "";
  process.childGeneration += 1;
  const generation = process.childGeneration;
  const child = process.spawn();
  process.child = child;
  let resolveExit: (value: ChildExit) => void;
  process.childExit = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve;
  });
  child.stdout?.on("data", (data) => {
    if (generation !== process.childGeneration) {
      return;
    }
    onStdoutData(process, data as string | Buffer);
  });
  child.stderr?.on("data", (data) => {
    if (generation !== process.childGeneration) {
      return;
    }
    onStderrData(process, data as string | Buffer);
  });
  child.on("error", (err) => {
    if (generation !== process.childGeneration) {
      return;
    }
    process.invalidate(new SkwProviderError("INTERNAL", err.message), true);
  });
  child.on("close", (code, signal) => {
    if (generation !== process.childGeneration) {
      return;
    }
    resolveExit({ code, signal });
    onChildClose(process, code, signal);
  });
}

export function onStdoutData(process: SkwProviderProcess, data: string | Buffer): void {
  if (process.state === "closed" || process.state === "failed") {
    return;
  }
  const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  process.stdoutBuffer = Buffer.concat([process.stdoutBuffer, chunk]);
  if (process.stdoutBuffer.length > MAX_FRAME_BYTES) {
    process.invalidate(
      new SkwProviderError("OUTPUT_LIMIT", "incoming frame exceeded 1 MiB"),
      false,
    );
    return;
  }
  let offset = 0;
  while (offset < process.stdoutBuffer.length) {
    const nl = process.stdoutBuffer.indexOf(0x0a, offset);
    if (nl === -1) {
      break;
    }
    const frame = process.stdoutBuffer.subarray(offset, nl + 1);
    offset = nl + 1;
    if (!isValidUtf8(frame)) {
      process.invalidate(new SkwProviderError("MALFORMED_OUTPUT", "invalid UTF-8 in frame"), false);
      return;
    }
    processFrame(process, frame);
  }
  if (offset > 0) {
    process.stdoutBuffer = process.stdoutBuffer.subarray(offset);
  }
}

export function processFrame(process: SkwProviderProcess, frame: Buffer): void {
  const text = frame.toString("utf8", 0, frame.length - 1); // drop newline
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.invalidate(new SkwProviderError("MALFORMED_OUTPUT", "frame is not valid JSON"), false);
    return;
  }
  let response: SkwWireResult;
  try {
    response = validateWireResponse(parsed);
  } catch (err) {
    process.invalidate(err as SkwProviderError, false);
    return;
  }
  if (!process.activeRequest) {
    process.invalidate(
      new SkwProviderError("MALFORMED_OUTPUT", "unexpected response without active request"),
      false,
    );
    return;
  }
  if (response.id !== process.activeRequest.id) {
    process.invalidate(new SkwProviderError("MALFORMED_OUTPUT", "response id mismatch"), false);
    return;
  }
  const active = process.activeRequest;
  process.clearActive();
  if ("error" in response) {
    active.reject(response.error);
  } else {
    active.resolve(response.result);
  }
  if (process.state !== "closing" && process.state !== "closed") {
    process.state = "idle";
  }
  process.processNext();
}

export function onStderrData(process: SkwProviderProcess, data: string | Buffer): void {
  const text = typeof data === "string" ? data : data.toString("utf8");
  process.stderrBuffer = (process.stderrBuffer + text).slice(-STDERR_RING_BYTES);
}

export function onChildClose(
  process: SkwProviderProcess,
  code: number | null,
  _signal: string | null,
): void {
  clearKillTimer(process);
  process.child = null;
  if (process.state === "closed" || process.state === "failed") {
    return;
  }
  if (process.state === "closing") {
    process.state = "closed";
    return;
  }
  if (process.stdoutBuffer.length > 0) {
    process.invalidate(new SkwProviderError("MALFORMED_OUTPUT", "partial frame at EOF"), false);
    return;
  }
  const error = new SkwProviderError(
    code === 0 ? "MALFORMED_OUTPUT" : "INTERNAL",
    `child exited unexpectedly (code ${code ?? "unknown"})`,
  );
  process.invalidate(error, true);
}

export function stopChild(process: SkwProviderProcess, signal: NodeJS.Signals): void {
  const child = process.child;
  if (!child) {
    return;
  }
  child.kill(signal);
  scheduleKill(process);
}

export function scheduleKill(process: SkwProviderProcess): void {
  clearKillTimer(process);
  const generation = process.childGeneration;
  process.killTimer = setTimeout(() => {
    if (generation !== process.childGeneration || !process.child) {
      return;
    }
    process.child.kill("SIGKILL");
  }, KILL_ESCALATION_MS);
}

export function clearKillTimer(process: SkwProviderProcess): void {
  if (process.killTimer) {
    clearTimeout(process.killTimer);
    process.killTimer = null;
  }
}

export function writeFrame(process: SkwProviderProcess, frame: Buffer): Promise<void> {
  if (frame.length > MAX_FRAME_BYTES) {
    return Promise.reject(new SkwProviderError("OUTPUT_LIMIT", "frame exceeds 1 MiB"));
  }
  const stdin = process.child?.stdin;
  if (!stdin) {
    return Promise.reject(new SkwProviderError("INTERNAL", "process stdin unavailable"));
  }
  const writable = stdin.write(frame);
  if (writable) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    stdin.once("drain", resolve);
    stdin.once("error", reject);
  });
}
