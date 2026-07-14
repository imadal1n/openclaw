// Persistent SKW provider process with strict NDJSON framing and lifecycle.
import { spawn, type ChildProcess } from "node:child_process";
import {
  MAX_PENDING_QUEUE,
  SkwProviderError,
  type SkwProviderProcessConfig,
} from "./skw-provider-framing.js";
import {
  clearActive as clearActiveImpl,
  enqueuePending,
  failActive,
  flushQueue,
  invalidate as invalidateImpl,
  processNextImpl,
} from "./skw-provider-process-engine.js";
import { stopChild } from "./skw-provider-process-io.js";
import { awaitChildExit, clearRefs, sendShutdownFrame } from "./skw-provider-process-lifecycle.js";
import type { ActiveRequest, PendingRequest, ProcessState } from "./skw-provider-process-state.js";

export class SkwProviderProcess {
  readonly config: SkwProviderProcessConfig;
  state: ProcessState = "starting";
  child: ChildProcess | null = null;
  childGeneration = 0;
  activeRequest: ActiveRequest | null = null;
  readonly pendingQueue: PendingRequest[] = [];
  stdoutBuffer = Buffer.alloc(0);
  stderrBuffer = "";
  killTimer: ReturnType<typeof setTimeout> | null = null;
  restartPending = false;
  canRestart = true;
  childExit: Promise<{ code: number | null; signal: string | null }> | null = null;

  constructor(config: SkwProviderProcessConfig) {
    this.config = config;
  }

  get lastStderr(): string {
    return this.stderrBuffer;
  }

  spawn(): ChildProcess {
    return spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: this.config.env,
      shell: false,
      windowsHide: true,
    });
  }

  request(params: {
    op: string;
    identity: import("./skw-provider-framing.js").SkwProviderIdentity;
    params: Record<string, unknown>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (this.state === "closed") {
      return Promise.reject(new SkwProviderError("ABORTED", "process is closed"));
    }
    if (this.state === "closing") {
      return Promise.reject(new SkwProviderError("UNAVAILABLE", "process is shutting down", true));
    }
    if (this.state === "failed" && !this.restartPending) {
      return Promise.reject(new SkwProviderError("INTERNAL", "process failed permanently"));
    }
    if (this.pendingQueue.length >= MAX_PENDING_QUEUE) {
      return Promise.reject(new SkwProviderError("UNAVAILABLE", "pending queue full", true));
    }
    if (params.signal?.aborted) {
      return Promise.reject(new SkwProviderError("ABORTED", "request already aborted"));
    }
    return new Promise<unknown>((resolve, reject) => {
      enqueuePending(this, { ...params, resolve, reject });
    });
  }

  async shutdown(params: { reason: string; timeoutMs: number }): Promise<unknown> {
    if (this.state === "closed" || this.state === "failed" || this.state === "closing") {
      return;
    }
    this.state = "closing";
    flushQueue(this, new SkwProviderError("UNAVAILABLE", "shutting down", true));
    if (this.activeRequest) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.activeRequest!.onDone = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, params.timeoutMs)),
      ]);
    }
    if (this.state !== "closing" || !this.child) {
      await awaitChildExit(this);
      this.state = "closed";
      clearRefs(this);
      return;
    }
    let result: unknown;
    try {
      result = await sendShutdownFrame(this, params.reason, params.timeoutMs);
    } catch (err) {
      stopChild(this, "SIGTERM");
      await awaitChildExit(this);
      this.state = "closed";
      clearRefs(this);
      throw err;
    }
    stopChild(this, "SIGTERM");
    await awaitChildExit(this);
    this.state = "closed";
    clearRefs(this);
    return result;
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (this.state !== "closing") {
      this.state = "closing";
      flushQueue(this, new SkwProviderError("ABORTED", "process closed", false));
      failActive(this, new SkwProviderError("ABORTED", "process closed", false));
      stopChild(this, "SIGTERM");
      await awaitChildExit(this);
    }
    await awaitChildExit(this);
    this.state = "closed";
    clearRefs(this);
  }

  invalidate(error: SkwProviderError, restartable: boolean): void {
    invalidateImpl(this, error, restartable);
  }

  clearActive(): void {
    clearActiveImpl(this);
  }

  processNext(): Promise<void> {
    return processNextImpl(this);
  }
}

export * from "./skw-provider-framing.js";
export * from "./skw-provider-process-engine.js";
export * from "./skw-provider-process-state.js";
export * from "./skw-provider-process-lifecycle.js";
export * from "./skw-provider-process-io.js";
