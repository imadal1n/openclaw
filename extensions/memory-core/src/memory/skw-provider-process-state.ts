// State types for the persistent SKW provider process.
import type { SkwProviderIdentity, SkwProviderProcessConfig } from "./skw-provider-framing.js";

export type ProcessState = "starting" | "idle" | "busy" | "closing" | "closed" | "failed";

export type ActiveRequest = {
  id: string;
  op: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onDone?: () => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

export type PendingRequest = {
  op: string;
  identity: SkwProviderIdentity;
  params: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type SkwProviderProcessFields = {
  config: SkwProviderProcessConfig;
  state: ProcessState;
  child: import("node:child_process").ChildProcess | null;
  childGeneration: number;
  activeRequest: ActiveRequest | null;
  pendingQueue: PendingRequest[];
  stdoutBuffer: Buffer;
  stderrBuffer: string;
  killTimer: ReturnType<typeof setTimeout> | null;
  restartPending: boolean;
  canRestart: boolean;
  childExit: Promise<{ code: number | null; signal: string | null }> | null;
};
