import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  defaultRuntime,
  formatErrorMessage,
  getMemorySearchManager,
  getRuntimeConfig,
  resolveCommandSecretRefsViaGateway,
  resolveDefaultAgentId,
  resolveMemoryBackendConfig,
  shortenHomePath,
  theme,
  withManager,
  type OpenClawConfig,
} from "../cli.host.runtime.js";
import type { MemoryAddCommandOptions } from "../cli.types.js";

const MAX_MEMORY_ADD_CONTENT_BYTES = 16 * 1024;
const MEMORY_SECRET_TARGET_IDS = new Set([
  "agents.defaults.memorySearch.remote.apiKey",
  "agents.list[].memorySearch.remote.apiKey",
]);

type MemoryManager = NonNullable<Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]>;

function resolveAgent(cfg: OpenClawConfig, agent?: string): string {
  const trimmed = agent?.trim();
  return trimmed ? trimmed : resolveDefaultAgentId(cfg);
}

async function loadMemoryAddConfig(): Promise<{ config: OpenClawConfig; diagnostics: string[] }> {
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: getRuntimeConfig(),
    commandName: "memory add",
    targetIds: MEMORY_SECRET_TARGET_IDS,
  });
  return { config: resolvedConfig, diagnostics };
}

function emitSecretDiagnostics(diagnostics: string[]): void {
  for (const entry of diagnostics) {
    defaultRuntime.log(theme.warn(`[secrets] ${entry}`));
  }
}

function resolveContentFilePath(contentFile: string | undefined): string | null {
  const trimmed = contentFile?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function targetToCategory(target: "user" | "general"): "user_pref" | "general" {
  return target === "user" ? "user_pref" : "general";
}

export async function runMemoryAdd(opts: MemoryAddCommandOptions): Promise<void> {
  const { config: cfg, diagnostics } = await loadMemoryAddConfig();
  emitSecretDiagnostics(diagnostics);
  const agentId = resolveAgent(cfg, opts.agent);

  const resolved = resolveMemoryBackendConfig({ cfg, agentId });
  if (resolved.backend !== "skw" || !resolved.skw?.effective?.writable) {
    defaultRuntime.error("Memory add requires a writable SKW backend.");
    process.exitCode = 1;
    return;
  }

  const target = opts.target;
  if (target !== "user" && target !== "general") {
    defaultRuntime.error("--target must be user or general.");
    process.exitCode = 1;
    return;
  }

  const contentPath = resolveContentFilePath(opts.contentFile);
  if (!contentPath) {
    defaultRuntime.error("Missing --content-file.");
    process.exitCode = 1;
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fsPromises.stat(contentPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      defaultRuntime.error(`Content file not found: ${shortenHomePath(contentPath)}`);
    } else {
      defaultRuntime.error(
        `Content file not accessible: ${shortenHomePath(contentPath)} (${code ?? "error"})`,
      );
    }
    process.exitCode = 1;
    return;
  }

  if (!stat.isFile()) {
    defaultRuntime.error(`Content file is not a regular file: ${shortenHomePath(contentPath)}`);
    process.exitCode = 1;
    return;
  }

  if (stat.size > MAX_MEMORY_ADD_CONTENT_BYTES) {
    defaultRuntime.error(
      `Content file exceeds ${MAX_MEMORY_ADD_CONTENT_BYTES} bytes: ${shortenHomePath(contentPath)}`,
    );
    process.exitCode = 1;
    return;
  }

  let content: string;
  try {
    content = await fsPromises.readFile(contentPath, "utf-8");
  } catch (err) {
    defaultRuntime.error(`Failed to read content file: ${formatErrorMessage(err)}`);
    process.exitCode = 1;
    return;
  }

  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager({ cfg, agentId }),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: async (manager) => {
      if (typeof manager.memoryWrite !== "function") {
        defaultRuntime.error("Memory add is not supported by the current backend.");
        process.exitCode = 1;
        return;
      }
      const eventId = randomUUID();
      try {
        await manager.memoryWrite({
          eventId,
          target,
          content,
          metadata: { category: targetToCategory(target) },
        });
        defaultRuntime.log(`Memory add complete (${agentId}). eventId=${eventId}`);
      } catch (err) {
        defaultRuntime.error(`Memory add failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    },
  });
}
