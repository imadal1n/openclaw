// Core request-engine helpers for the persistent SKW provider process.
import { randomUUID } from "node:crypto";
import { buildFrame, SkwProviderError } from "./skw-provider-framing.js";
import { spawnChild, stopChild, writeFrame } from "./skw-provider-process-io.js";
import type { ActiveRequest, PendingRequest } from "./skw-provider-process-state.js";
import type { SkwProviderProcess } from "./skw-provider-process.js";

export async function processNextImpl(process: SkwProviderProcess): Promise<void> {
  if (process.state === "closing" || process.state === "closed") {
    return;
  }
  if (process.state === "failed" && !process.restartPending) {
    return;
  }
  if (process.activeRequest || process.pendingQueue.length === 0) {
    return;
  }
  const next = process.pendingQueue.shift();
  if (!next) {
    return;
  }
  if (next.signal?.aborted) {
    next.reject(new SkwProviderError("ABORTED", "request aborted"));
    processNextImpl(process).catch(() => {});
    return;
  }
  if (next.signal && next.abortListener) {
    next.signal.removeEventListener("abort", next.abortListener);
  }
  const id = randomUUID();
  const abortHandler = () => {
    if (process.activeRequest?.id !== id) {
      return;
    }
    onAbort(process, next.op);
  };
  next.signal?.addEventListener("abort", abortHandler, { once: true });
  process.activeRequest = {
    id,
    op: next.op,
    resolve: next.resolve,
    reject: next.reject,
    timer: setTimeout(() => onTimeout(process, next.op), next.timeoutMs),
    signal: next.signal,
    abortHandler,
  } as ActiveRequest;
  try {
    await sendActiveRequest(process, next.op, next.identity, next.params);
  } catch (err) {
    const error = err as SkwProviderError;
    if (process.activeRequest) {
      failActive(process, error);
    }
    invalidate(process, error, false);
  }
}

export async function sendActiveRequest(
  process: SkwProviderProcess,
  op: string,
  identity: { agentId: string; profile: string },
  params: Record<string, unknown>,
): Promise<void> {
  await ensureChild(process);
  if (process.activeRequest === null) {
    return;
  }
  if (process.state === "closing" || process.state === "closed") {
    throw new SkwProviderError("ABORTED", "process closed", false);
  }
  if (process.state === "failed" && !process.restartPending) {
    throw new SkwProviderError("INTERNAL", "process failed permanently");
  }
  process.state = "busy";
  await writeFrame(process, buildFrame(process.activeRequest.id, op, identity, params));
}

export async function ensureChild(process: SkwProviderProcess): Promise<void> {
  if (process.child && process.state !== "failed") {
    return;
  }
  if (process.state === "failed" && !process.restartPending) {
    throw new SkwProviderError("INTERNAL", "process restart already exhausted");
  }
  if (process.child) {
    await process.childExit;
  }
  spawnChild(process);
}

export function invalidate(
  process: SkwProviderProcess,
  error: SkwProviderError,
  restartable: boolean,
): void {
  if (process.state === "closed" || process.state === "failed" || process.state === "closing") {
    return;
  }
  process.state = "failed";
  process.restartPending = restartable && process.canRestart;
  process.canRestart = process.canRestart && !restartable;
  stopChild(process, "SIGTERM");
  failActive(process, error);
  flushQueue(process, new SkwProviderError("UNAVAILABLE", "process invalidated", true));
  processNextImpl(process).catch(() => {});
}

export function onTimeout(process: SkwProviderProcess, op: string): void {
  if (process.state === "closed" || process.state === "failed" || process.state === "closing") {
    return;
  }
  invalidate(process, new SkwProviderError("TIMEOUT", `${op} timed out`), true);
}

export function onAbort(process: SkwProviderProcess, op: string): void {
  if (process.state === "closed" || process.state === "failed" || process.state === "closing") {
    return;
  }
  invalidate(process, new SkwProviderError("ABORTED", `${op} aborted`), true);
}

export function failActive(process: SkwProviderProcess, error: SkwProviderError): void {
  const active = process.activeRequest;
  if (!active) {
    return;
  }
  clearActive(process);
  active.reject(error);
}

export function clearActive(process: SkwProviderProcess): void {
  const active = process.activeRequest;
  if (!active) {
    return;
  }
  clearTimeout(active.timer);
  if (active.signal && active.abortHandler) {
    active.signal.removeEventListener("abort", active.abortHandler);
  }
  active.onDone?.();
  process.activeRequest = null;
}

export function flushQueue(process: SkwProviderProcess, error: SkwProviderError): void {
  while (process.pendingQueue.length > 0) {
    const pending = process.pendingQueue.shift()!;
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    pending.reject(error);
  }
}

export function enqueuePending(process: SkwProviderProcess, pending: PendingRequest): void {
  const onAbort = () => {
    const index = process.pendingQueue.indexOf(pending);
    if (index !== -1) {
      process.pendingQueue.splice(index, 1);
    }
    pending.reject(new SkwProviderError("ABORTED", "request aborted"));
  };
  if (pending.signal) {
    pending.abortListener = onAbort;
    pending.signal.addEventListener("abort", onAbort, { once: true });
  }
  process.pendingQueue.push(pending);
  processNextImpl(process).catch(() => {});
}
