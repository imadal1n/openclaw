// Global pool for persistent SKW provider processes.
import type { MemoryProviderStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { SkwProviderError } from "./skw-provider-framing.js";
import type { SkwProviderProcess } from "./skw-provider-process.js";

export const MAX_POOL_PROCESSES = 4;
export const IDLE_DEADLINE_MS = 10 * 60 * 1000;

type Initializer = (process: SkwProviderProcess) => Promise<MemoryProviderStatus>;

type PoolEntry = {
  key: string;
  replacementKey?: string;
  process: SkwProviderProcess;
  status: MemoryProviderStatus;
  refcount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
  promise?: Promise<{ process: SkwProviderProcess; status: MemoryProviderStatus }>;
};

export class SkwProviderPool {
  private readonly max: number;
  private readonly entries = new Map<string, PoolEntry>();
  private recency = 0;

  constructor(max = MAX_POOL_PROCESSES) {
    this.max = max;
  }

  async acquire(
    key: string,
    factory: () => SkwProviderProcess,
    initializer: Initializer,
    options: { replacementKey?: string } = {},
  ): Promise<{ process: SkwProviderProcess; status: MemoryProviderStatus }> {
    const existing = this.entries.get(key);
    if (existing) {
      if (!this.isReusable(existing)) {
        await this.closeEntry(existing, "stale provider process replaced");
      } else if (existing.promise) {
        const result = await existing.promise;
        this.hold(existing);
        return result;
      } else {
        this.hold(existing);
        return { process: existing.process, status: existing.status };
      }
    }

    await this.closeReplacedEntries(key, options.replacementKey);
    await this.ensureCapacity();

    const process = factory();
    const entry: PoolEntry = {
      key,
      replacementKey: options.replacementKey,
      process,
      status: { backend: "skw", provider: "skw" },
      refcount: 1,
      idleTimer: null,
      lastUsed: this.nextRecency(),
    };
    this.entries.set(key, entry);

    const promise = (async () => {
      const status = await initializer(process);
      entry.status = status;
      entry.promise = undefined;
      return { process, status };
    })();
    entry.promise = promise;

    try {
      return await promise;
    } catch (err) {
      await this.closeEntry(entry, "provider initialization failed");
      throw err;
    }
  }

  release(process: SkwProviderProcess): void {
    for (const entry of this.entries.values()) {
      if (entry.process === process) {
        entry.refcount = Math.max(0, entry.refcount - 1);
        if (entry.refcount === 0) {
          entry.idleTimer = setTimeout(() => {
            void this.closeEntry(entry, "idle provider process expired");
          }, IDLE_DEADLINE_MS);
        }
        return;
      }
    }
  }

  setStatus(key: string, status: MemoryProviderStatus): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.status = status;
      entry.lastUsed = this.nextRecency();
    }
  }

  getStatus(key: string): MemoryProviderStatus | undefined {
    return this.entries.get(key)?.status;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => this.closeEntry(entry, "provider pool closed")),
    );
  }

  private hold(entry: PoolEntry): void {
    entry.refcount += 1;
    entry.lastUsed = this.nextRecency();
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private nextRecency(): number {
    this.recency += 1;
    return this.recency;
  }

  private async closeReplacedEntries(
    key: string,
    replacementKey: string | undefined,
  ): Promise<void> {
    if (!replacementKey) {
      return;
    }
    const staleEntries = [...this.entries.values()].filter(
      (entry) => entry.key !== key && entry.replacementKey === replacementKey,
    );
    for (const entry of staleEntries) {
      await this.closeEntry(entry, "provider config changed");
    }
  }

  private async ensureCapacity(): Promise<void> {
    while (this.entries.size >= this.max) {
      const evicted = await this.evictLruIdle();
      if (!evicted) {
        throw new SkwProviderError("UNAVAILABLE", "all provider slots busy", true);
      }
    }
  }

  private isReusable(entry: PoolEntry): boolean {
    return entry.process.state !== "closed" && entry.process.state !== "closing";
  }

  private isBusy(entry: PoolEntry): boolean {
    return (
      Boolean(entry.promise) ||
      entry.process.state === "starting" ||
      entry.process.state === "busy" ||
      entry.process.state === "closing" ||
      Boolean(entry.process.activeRequest) ||
      entry.process.pendingQueue.length > 0
    );
  }

  private async evictLruIdle(): Promise<boolean> {
    const idle = [...this.entries.values()]
      .filter((entry) => !this.isBusy(entry))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const entry = idle[0];
    if (!entry) {
      return false;
    }
    await this.closeEntry(entry, "least recently used idle provider evicted");
    return true;
  }

  private rejectActive(entry: PoolEntry, reason: string): void {
    entry.process.activeRequest?.reject(new SkwProviderError("UNAVAILABLE", reason, true));
  }

  private async closeEntry(entry: PoolEntry, reason: string): Promise<void> {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.entries.delete(entry.key);
    this.rejectActive(entry, reason);
    const closePromise = entry.process.close();
    const pending = entry.promise ? [entry.promise, closePromise] : [closePromise];
    await Promise.allSettled(pending);
  }
}

export const skwProviderPool = new SkwProviderPool();
