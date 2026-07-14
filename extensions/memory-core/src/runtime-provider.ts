// Memory Core provider module implements model/runtime integration.
import type {
  MemoryPluginRuntime,
  MemoryRuntimeCapabilities,
  MemoryRuntimeCapability,
  MemoryRuntimeStatus,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";

const memoryRuntimeStatusCache = new Map<string, MemoryRuntimeStatus>();

function hashConfig(cfg: OpenClawConfig): string {
  const str = JSON.stringify(cfg);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(16);
}

function getMemoryRuntimeStatusCacheKey(params: { cfg: OpenClawConfig; agentId: string }): string {
  return `${params.agentId}:${hashConfig(params.cfg)}`;
}

function getCachedMemoryRuntimeStatus(key: string): MemoryRuntimeStatus | undefined {
  return memoryRuntimeStatusCache.get(key);
}

function setMemoryRuntimeStatus(key: string, status: MemoryRuntimeStatus): void {
  memoryRuntimeStatusCache.set(key, status);
}

export function getMemoryRuntimeStatus(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryRuntimeStatus {
  const key = getMemoryRuntimeStatusCacheKey(params);
  const cached = getCachedMemoryRuntimeStatus(key);
  if (cached) {
    return cached;
  }
  const resolved = resolveMemoryBackendConfig(params);
  const status: MemoryRuntimeStatus = {
    backend: resolved.backend,
    profile: resolved.skw?.profile,
    ready: resolved.backend === "builtin",
  };
  setMemoryRuntimeStatus(key, status);
  return status;
}

export function getMemoryRuntimeCapabilities(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryRuntimeCapabilities {
  const resolved = resolveMemoryBackendConfig(params);
  const features = new Set<MemoryRuntimeCapability>(["search", "get"]);
  const base: MemoryRuntimeCapabilities = {
    backend: resolved.backend,
    features,
    writable: false,
    autoExtract: false,
    prefetch: false,
  };
  if (resolved.backend === "skw" && resolved.skw?.effective) {
    base.writable = resolved.skw.effective.writable;
    base.autoExtract = resolved.skw.effective.autoExtract;
    base.prefetch = resolved.skw.effective.prefetch;
    if (base.writable) {
      features.add("write");
    }
    if (base.autoExtract) {
      features.add("autoExtract");
    }
    if (base.prefetch) {
      features.add("prefetch");
    }
  }
  return base;
}

export const memoryRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { manager, error } = await getMemorySearchManager(params);
    return {
      manager,
      error,
    };
  },
  resolveMemoryBackendConfig(params) {
    return resolveMemoryBackendConfig(params);
  },
  getMemoryRuntimeStatus(params) {
    return getMemoryRuntimeStatus(params);
  },
  async probeMemoryRuntime(params) {
    const startMs = Date.now();
    try {
      const { manager, error } = await getMemorySearchManager({
        ...params,
        purpose: "status",
      });
      const latencyMs = Date.now() - startMs;
      const resolved = resolveMemoryBackendConfig(params);
      const key = getMemoryRuntimeStatusCacheKey(params);
      const status: MemoryRuntimeStatus = {
        backend: resolved.backend,
        profile: resolved.skw?.profile,
        ready: manager !== null,
        ...(error ? { lastError: error } : {}),
        lastProbeAtMs: Date.now(),
      };
      setMemoryRuntimeStatus(key, status);
      return {
        ok: manager !== null,
        ...(error ? { error } : {}),
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const error = err instanceof Error ? err.message : String(err);
      const resolved = resolveMemoryBackendConfig(params);
      const key = getMemoryRuntimeStatusCacheKey(params);
      const status: MemoryRuntimeStatus = {
        backend: resolved.backend,
        profile: resolved.skw?.profile,
        ready: false,
        lastError: error,
        lastProbeAtMs: Date.now(),
      };
      setMemoryRuntimeStatus(key, status);
      return { ok: false, error, latencyMs };
    }
  },
  getMemoryRuntimeCapabilities(params) {
    return getMemoryRuntimeCapabilities(params);
  },
  async closeAllMemorySearchManagers() {
    await closeAllMemorySearchManagers();
  },
  async closeMemorySearchManager(params) {
    await closeMemorySearchManager(params);
  },
};
