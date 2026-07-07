/**
 * Sandbox registry pruning.
 *
 * Removes stale runtime containers and browser bridges on a best-effort schedule.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../../config/config.js";
import { stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";
import { defaultRuntime } from "../../runtime.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { getSandboxBackendManager } from "./backend.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import { resolveSandboxWorkspaceDir } from "./shared.js";
import type { SandboxConfig } from "./types.js";

let lastPruneAtMs = 0;

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "backendId" | "createdAtMs" | "lastUsedAtMs"
>;

function shouldPruneSandboxEntry(cfg: SandboxConfig, now: number, entry: PruneableRegistryEntry) {
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) {
    return false;
  }
  const nowMs = asDateTimestampMs(now) ?? 0;
  const lastUsedAtMs = asDateTimestampMs(entry.lastUsedAtMs) ?? 0;
  const createdAtMs = asDateTimestampMs(entry.createdAtMs) ?? 0;
  const idleMs = nowMs - lastUsedAtMs;
  const ageMs = nowMs - createdAtMs;
  return (
    (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
    (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
  );
}

function formatPruneErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);
}

function logSandboxPruneRemovalError(entry: { containerName: string }, error: unknown): void {
  const message = formatPruneErrorMessage(error);
  defaultRuntime.error?.(
    `Sandbox prune failed to remove ${entry.containerName}: ${message ?? "unknown error"}`,
  );
}

function hasRemainingSameScopeSibling(params: {
  entry: SandboxRegistryEntry;
  entries: readonly SandboxRegistryEntry[];
  removedRuntimeContainerNames: ReadonlySet<string>;
  sessionKey: string;
}): boolean {
  return params.entries.some(
    (candidate) =>
      candidate.containerName !== params.entry.containerName &&
      candidate.sessionKey === params.sessionKey &&
      !params.removedRuntimeContainerNames.has(candidate.containerName),
  );
}

async function removeSandboxSkillsWorkspaceIfFinalScopeRuntime(params: {
  entry: SandboxRegistryEntry;
  entries: readonly SandboxRegistryEntry[];
  removedRuntimeContainerNames: ReadonlySet<string>;
}): Promise<void> {
  const sessionKey = params.entry.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  if (
    hasRemainingSameScopeSibling({
      ...params,
      sessionKey,
    })
  ) {
    return;
  }
  const skillsWorkspaceDir = resolveSandboxWorkspaceDir(
    path.join(SANDBOX_STATE_DIR, "skills-workspaces"),
    sessionKey,
  );
  await fs.rm(skillsWorkspaceDir, { recursive: true, force: true });
}

/** Removes expired registry entries and their backing runtime resources. */
async function pruneSandboxRegistryEntries<TEntry extends SandboxRegistryEntry>(params: {
  cfg: SandboxConfig;
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (containerName: string) => Promise<void>;
  removeRuntime: (entry: TEntry) => Promise<void>;
  onRemoved?: (entry: TEntry) => Promise<void>;
}) {
  const now = Date.now();
  if (params.cfg.prune.idleHours === 0 && params.cfg.prune.maxAgeDays === 0) {
    return;
  }
  const registry = await params.read();
  for (const entry of registry.entries) {
    if (!shouldPruneSandboxEntry(params.cfg, now, entry)) {
      continue;
    }
    try {
      await params.removeRuntime(entry);
      await params.remove(entry.containerName);
      await params.onRemoved?.(entry);
    } catch (error) {
      logSandboxPruneRemovalError(entry, error);
    }
  }
}

/** Prunes ordinary sandbox runtime containers from the configured backend manager. */
async function pruneSandboxContainers(cfg: SandboxConfig) {
  const config = getRuntimeConfig();
  const now = Date.now();
  if (cfg.prune.idleHours === 0 && cfg.prune.maxAgeDays === 0) {
    return;
  }
  const registry = await readRegistry();
  const removedRuntimeContainerNames = new Set<string>();
  for (const entry of registry.entries) {
    if (!shouldPruneSandboxEntry(cfg, now, entry)) {
      continue;
    }
    try {
      const manager = getSandboxBackendManager(entry.backendId ?? "docker");
      await manager?.removeRuntime({
        entry,
        config,
      });
      removedRuntimeContainerNames.add(entry.containerName);
      await removeSandboxSkillsWorkspaceIfFinalScopeRuntime({
        entry,
        entries: registry.entries,
        removedRuntimeContainerNames,
      });
      await removeRegistryEntry(entry.containerName);
    } catch (error) {
      logSandboxPruneRemovalError(entry, error);
    }
  }
}

/** Prunes browser bridge containers and closes matching in-process bridge servers. */
async function pruneSandboxBrowsers(cfg: SandboxConfig) {
  const config = getRuntimeConfig();
  await pruneSandboxRegistryEntries<
    SandboxBrowserRegistryEntry & {
      backendId?: string;
      runtimeLabel?: string;
      configLabelKind?: string;
    }
  >({
    cfg,
    read: readBrowserRegistry,
    remove: removeBrowserRegistryEntry,
    removeRuntime: async (entry) => {
      await dockerSandboxBackendManager.removeRuntime({
        entry: {
          ...entry,
          backendId: "docker",
          runtimeLabel: entry.containerName,
          configLabelKind: "Image",
        },
        config,
      });
    },
    onRemoved: async (entry) => {
      const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
      if (bridge?.containerName === entry.containerName) {
        await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
        BROWSER_BRIDGES.delete(entry.sessionKey);
      }
    },
  });
}

/** Runs sandbox pruning at most once per throttle window. */
export async function maybePruneSandboxes(cfg: SandboxConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;
  try {
    await pruneSandboxContainers(cfg);
    await pruneSandboxBrowsers(cfg);
  } catch (error) {
    const message = formatPruneErrorMessage(error);
    defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
  }
}
