import type {
  AgentEndParams,
  EndSessionParams,
  FinishCompactionParams,
  MemorySearchManager,
  PrepareCompactionParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildSessionEndContext,
  normalizeMessages,
  resolveAgentEndEventId,
} from "./skw-lifecycle-hooks.helpers.js";

export type SkwLifecycleHookRuntime = Pick<MemoryPluginRuntime, "getMemorySearchManager">;

async function resolveMemoryManager(params: {
  runtime: SkwLifecycleHookRuntime;
  getConfig?: () => OpenClawConfig | undefined;
  agentId: string;
}): Promise<MemorySearchManager | null> {
  const cfg = params.getConfig?.();
  if (!cfg) {
    return null;
  }
  const { manager } = await params.runtime.getMemorySearchManager({
    cfg,
    agentId: params.agentId,
  });
  return manager;
}

export async function handleSkwAgentEnd(params: {
  event: PluginHookAgentEndEvent;
  ctx: PluginHookAgentContext;
  runtime: SkwLifecycleHookRuntime;
  getConfig?: () => OpenClawConfig | undefined;
  log?: (message: string) => void;
}): Promise<void> {
  const sessionId = params.ctx.sessionId;
  const sessionKey = params.ctx.sessionKey;
  const agentId = params.ctx.agentId;
  if (!agentId) {
    params.log?.("skw-lifecycle: agent_end skipped, no agentId");
    return;
  }
  if (!params.event.success) {
    return;
  }
  const messages = normalizeMessages(params.event.messages ?? []);
  const eventId = resolveAgentEndEventId({
    runId: params.event.runId ?? params.ctx.runId,
    sessionId,
    sessionKey,
  });
  const manager = await resolveMemoryManager({
    runtime: params.runtime,
    getConfig: params.getConfig,
    agentId,
  });
  if (!manager?.agentEnd) {
    params.log?.("skw-lifecycle: agent_end skipped, no agentEnd contract");
    return;
  }
  const agentEndParams: AgentEndParams = {
    sessionId,
    sessionKey,
    eventId,
    success: params.event.success,
    messages,
  };
  if (typeof params.event.durationMs === "number" && Number.isFinite(params.event.durationMs)) {
    agentEndParams.durationMs = params.event.durationMs;
  }
  try {
    await manager.agentEnd(agentEndParams);
  } catch (err) {
    params.log?.(
      `skw-lifecycle: agentEnd failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleSkwSessionEnd(params: {
  event: PluginHookSessionEndEvent;
  ctx: PluginHookSessionContext;
  runtime: SkwLifecycleHookRuntime;
  getConfig?: () => OpenClawConfig | undefined;
  log?: (message: string) => void;
}): Promise<void> {
  const agentId = params.ctx.agentId;
  if (!agentId) {
    params.log?.("skw-lifecycle: session_end skipped, no agentId");
    return;
  }
  const manager = await resolveMemoryManager({
    runtime: params.runtime,
    getConfig: params.getConfig,
    agentId,
  });
  if (!manager?.endSession) {
    params.log?.("skw-lifecycle: session_end skipped, no endSession contract");
    return;
  }
  const context: EndSessionParams = buildSessionEndContext({ event: params.event });
  try {
    await manager.endSession(context);
  } catch (err) {
    params.log?.(
      `skw-lifecycle: endSession failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleSkwBeforeCompaction(params: {
  event: PluginHookBeforeCompactionEvent;
  ctx: PluginHookAgentContext;
  runtime: SkwLifecycleHookRuntime;
  getConfig?: () => OpenClawConfig | undefined;
  compactionId: string;
  log?: (message: string) => void;
}): Promise<void> {
  const agentId = params.ctx.agentId;
  if (!agentId) {
    params.log?.("skw-lifecycle: before_compaction skipped, no agentId");
    return;
  }
  const manager = await resolveMemoryManager({
    runtime: params.runtime,
    getConfig: params.getConfig,
    agentId,
  });
  if (!manager?.prepareCompaction) {
    params.log?.("skw-lifecycle: before_compaction skipped, no prepareCompaction contract");
    return;
  }
  const messages = normalizeMessages(params.event.messages ?? []);
  try {
    const prepareParams: PrepareCompactionParams = {
      sessionId: params.ctx.sessionId,
      sessionKey: params.ctx.sessionKey,
      compactionId: params.compactionId,
      messages,
      maxCharacters: params.event.maxCharacters ?? 8192,
    };
    await manager.prepareCompaction(prepareParams);
  } catch (err) {
    params.log?.(
      `skw-lifecycle: prepareCompaction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleSkwAfterCompaction(params: {
  event: PluginHookAfterCompactionEvent;
  ctx: PluginHookAgentContext;
  runtime: SkwLifecycleHookRuntime;
  getConfig?: () => OpenClawConfig | undefined;
  compactionId: string;
  outcome: "success" | "failed";
  compactedCount?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const agentId = params.ctx.agentId;
  if (!agentId) {
    params.log?.("skw-lifecycle: after_compaction skipped, no agentId");
    return;
  }
  if (!params.compactionId) {
    params.log?.("skw-lifecycle: after_compaction skipped, no compactionId");
    return;
  }
  const manager = await resolveMemoryManager({
    runtime: params.runtime,
    getConfig: params.getConfig,
    agentId,
  });
  if (!manager?.finishCompaction) {
    params.log?.("skw-lifecycle: after_compaction skipped, no finishCompaction contract");
    return;
  }
  try {
    const finishParams: FinishCompactionParams = {
      sessionId: params.ctx.sessionId,
      sessionKey: params.ctx.sessionKey,
      compactionId: params.compactionId,
      outcome: params.outcome,
    };
    if (params.outcome === "success" && typeof params.compactedCount === "number") {
      finishParams.compactedCount = params.compactedCount;
    }
    await manager.finishCompaction(finishParams);
  } catch (err) {
    params.log?.(
      `skw-lifecycle: finishCompaction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
