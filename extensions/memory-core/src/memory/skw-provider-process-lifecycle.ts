// Lifecycle helpers for the persistent SKW provider process.
import { randomUUID } from "node:crypto";
import { buildFrame, SkwProviderError } from "./skw-provider-framing.js";
import { clearKillTimer, writeFrame } from "./skw-provider-process-io.js";
import type { SkwProviderProcess } from "./skw-provider-process.js";

export function sendShutdownFrame(
  process: SkwProviderProcess,
  reason: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.clearActive();
      reject(new SkwProviderError("TIMEOUT", "shutdown timed out"));
    }, timeoutMs);
    const id = randomUUID();
    process.activeRequest = {
      id,
      op: "shutdown",
      resolve: (value) => {
        clearTimeout(timer);
        process.clearActive();
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        process.clearActive();
        reject(err);
      },
      timer,
    };
    writeFrame(process, buildFrame(id, "shutdown", { agentId: "", profile: "" }, { reason })).catch(
      (err) => {
        clearTimeout(timer);
        process.clearActive();
        reject(err);
      },
    );
  });
}

export async function awaitChildExit(process: SkwProviderProcess): Promise<void> {
  if (process.child && process.childExit) {
    await process.childExit;
  }
}

export function clearRefs(process: SkwProviderProcess): void {
  clearKillTimer(process);
  process.stdoutBuffer = Buffer.alloc(0);
  process.stderrBuffer = "";
}
