import type {
  MemoryPluginRuntime,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
} from "openclaw/plugin-sdk/types";

export function registerSkwPrefetchHook(params: {
  api: OpenClawPluginApi;
  runtime: MemoryPluginRuntime;
}): void {
  params.api.on("before_prompt_build", async (event, ctx) => {
    return await buildSkwPrefetchHookResult({
      event,
      ctx,
      runtime: params.runtime,
      getConfig: () =>
        (params.api.runtime.config?.current?.() ?? params.api.config) as OpenClawConfig,
    });
  });
}

export async function buildSkwPrefetchHookResult(params: {
  event: PluginHookBeforePromptBuildEvent;
  ctx: PluginHookAgentContext;
  runtime: MemoryPluginRuntime;
  getConfig: () => OpenClawConfig | undefined;
}): Promise<PluginHookBeforePromptBuildResult> {
  const { agentId, sessionId, sessionKey } = params.ctx;
  if (!agentId?.trim() || !sessionId?.trim() || !sessionKey?.trim()) {
    return {};
  }

  const cfg = params.getConfig();
  if (!cfg) {
    return {};
  }

  const capabilities = params.runtime.getMemoryRuntimeCapabilities({ cfg, agentId });
  if (capabilities.backend !== "skw" || !capabilities.prefetch) {
    return {};
  }

  const { manager } = await params.runtime.getMemorySearchManager({
    cfg,
    agentId,
    purpose: "default",
  });
  if (!manager || typeof manager.prefetch !== "function") {
    return {};
  }

  try {
    const prefetch = await manager.prefetch({
      query: params.event.prompt,
      sessionKey,
      sessionId,
    });
    const result: PluginHookBeforePromptBuildResult = {};
    if (prefetch.systemPromptBlock?.trim()) {
      result.appendSystemContext = prefetch.systemPromptBlock.trim();
    }
    const abstained = "quality" in prefetch && prefetch.quality === "abstain";
    if (prefetch.context?.trim() && !abstained) {
      result.prependContext = prefetch.context.trim();
    }
    return result;
  } catch {
    return {};
  }
}
