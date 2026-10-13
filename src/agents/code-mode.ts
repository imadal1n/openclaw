import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeControlTool,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import {
  normalizeCodeModeTimeoutResult,
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
} from "./code-mode-errors.js";
import { runCodeModeExec, runWait } from "./code-mode-execution.js";
import { runCodeModeScriptHeadless } from "./code-mode-headless.js";
import { markCodeModePermissionChangeResult } from "./code-mode-permission-change.js";
import {
  isCodeModeEngagedForModel,
  readCode,
  readRunId,
  resolveCodeModeConfig,
} from "./code-mode-runtime.js";
import { recordCodeModeToolOutcome } from "./code-mode-tool-outcome.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { copyInternalToolResultState } from "./runtime/internal-hooks.js";
import { executionTitleSchema } from "./schema/typebox.js";
import { resolveSwarmConfig } from "./subagents/swarm/swarm-config.js";
import { resolveToolResultBudget } from "./tool-result-limits.js";
import { applyToolCatalogCompaction, isDirectVisibleCatalogTool } from "./tool-search-catalog.js";
import { formatToolSearchControlResult, type ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogRef,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

export { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME };
export {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  isCodeModeEngagedForModel,
  runCodeModeScriptHeadless,
  resolveCodeModeConfig,
};
export type { CodeModeFailureCode, CodeModeHeadlessResult } from "./code-mode-runtime.js";

type CodeModeToolContext = ToolSearchToolContext & { modelContextWindowTokens?: number };

// The exec description is deliberately catalog-independent: it must stay
// byte-stable for the whole session so catalog drift (late MCP connects,
// plugin loads, client tool shadows, owner changes) never rewrites the
// provider-visible tools array and invalidates the reusable prompt prefix.
// Current tool names, schemas, and owners are obtained at runtime through
// `catalog.search` / `API.list`, so the prompt never advertises a contract
// that a mid-session collision may already have moved to another owner.
const CODE_MODE_SHELL_DISCOVERY_GUIDANCE =
  " For heavier computation, discover the shell tool with `catalog.search` or `API.list` and call the returned callable; its name and schema come from discovery, not from this prompt.";

function createCodeModeExecDescription(
  ctx: CodeModeToolContext,
  config = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId),
): string {
  // Native tools have schema-derived declarations too; keep remote schemas deferred.
  const apiGuidance =
    " Read types with `API.list(prefix?)` and `API.read(path)`; read returns `{ path, description, content, bytes }`, not a string. Use `.content` for declaration text. Native tools: `tools/`. Types are documentation; write plain JavaScript.";
  const mcpGuidance = " MCP tools use the `MCP` namespace or callable `catalog.search` handles.";
  // Detached reviews retain the admitted catalog. Execution-only restrictions
  // belong to the bridge; applying them here would rewrite the shared prompt prefix.
  const swarmGuidance = resolveSwarmConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId).enabled
    ? " Swarm globals `agents.run`, `phase`, and `log` support orchestration when this run permits spawning; read `agents.d.ts` for types and orchestration idioms."
    : "";
  // Availability hedges keep the text stable without advertising a namespace a
  // run cannot resolve; discovery (API.list/catalog.search) is the source of truth.
  const nodesGuidance =
    "\n- nodes: when paired Gateway nodes are connected: nodes.list(), (await nodes.get(id)).invoke(command, params)\n";
  const skillsGuidance =
    " Installed skills, when present: use `await skills.search(query, limit)` to find relevant skills. `await skills.list()` lists up to 20 entries; pass an offset for later pages. Use `await skills.read(name)` for complete installed skill instructions. A known exact name can be read directly.";
  const mcpNamespacePrompt = [
    "MCP namespace globals are available in code mode when MCP servers are connected:",
    "- MCP: MCP server tools grouped by server.",
    'Read API files such as mcp/index.d.ts and mcp/<server>.d.ts for TypeScript-style MCP headers; list connected servers with API.list("mcp/"). Node-backed name collisions use a sanitized node-id fragment prefix.',
    "Search native and MCP tools by task with catalog.search(query). MCP handles expose callableName, apiPath, and describe() for the exact header and schema. Call the handle or MCP.<server>.<tool>({ ...input }) with one object argument matching the header.",
  ].join("\n");
  const { maxOutputBytes, timeoutMs } = config;
  return (
    `Run JavaScript in OpenClaw. Each \`exec\` runs in a fresh JavaScript context; variables, functions and imports never carry over between cells. Set \`title\` to a 3–7 word purpose. Guest work and inline tool waits share a ${timeoutMs} ms wall-clock budget per \`exec\`/\`wait\`; approvals pause it. Guest computation over this budget times out. awaitResults:true keeps needed results owned and pauses only off-VM tool waits; run/tool deadlines still apply. Other pending tools may return \`waiting\` for \`wait\`.` +
    CODE_MODE_SHELL_DISCOVERY_GUIDANCE +
    ` Enabled tools are async global functions. Await dependent calls in order; independent calls may run with Promise.all. Declared output fields may feed later calls in the same program; avoid extra inspection calls. Emit output with \`text(value)\` or \`json(value)\`. Return the final value, otherwise \`null\`. Oversized final objects/arrays may return \`value.reference\`. \`-> ?\` means unknown output: do not feed it into guessed field-dependent logic in the same program. Return it raw or \`await results.save(value)\`; use a later \`exec\` for dependent composition. Save returns \`{id,bytes,count,shape,preview,previewTruncated}\`: emit that descriptor directly; full JSON stays stored. Load/delete with \`results.load(id)\`/\`results.delete(id)\`. Saved results references expire when the current reply ends; never reuse reference ids from earlier turns; use \`store\` for data needed later. \`await store(key, value)\`/\`await load(key)\` keep small JSON values across cells and turns in this session (survive restarts); contract: \`API.read("results.d.ts")\`. For omitted tools, use \`catalog.search(query)\`; results are callable: \`const [tool] = await catalog.search("..."); return await tool({...});\`. Use handle \`describe()\` for schemas. \`setTimeout\` and \`clearTimeout\` work. \`TextEncoder\`/\`TextDecoder\` convert local text and bytes. Console log/info/warn/error/debug emit bounded text. Nested calls enforce normal tool policy and approvals. Tool failures are catchable; inspect possible effects before retrying. Nested results are intact or throw resource errors. Cell reply inbox: ${Math.min(config.memoryLimitBytes, config.maxSnapshotBytes)} bytes; consume replies or paginate if full. Output/value/errors share ${maxOutputBytes} bytes across waits. Other truncation reports original JSON prefixes/omitted bytes; rerun with narrower args. Output is incremental; changed cumulative summaries replace earlier ones. Node.js modules and \`require\`/\`import\` are NOT available; use tools for external actions.` +
    apiGuidance +
    mcpGuidance +
    swarmGuidance +
    nodesGuidance +
    skillsGuidance +
    " `code` is JavaScript, never a shell command; do not retry failed shell source." +
    `\n\n${mcpNamespacePrompt}`
  );
}

export function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[] {
  const runtimeRefresh = captureAgentPluginRuntimeRefresh();
  // The surface planner owns activation. Capture limits once so an admitted
  // control remains executable during model overrides and restart recovery.
  const config = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId);
  const resultBudget = resolveToolResultBudget(ctx.modelContextWindowTokens);
  const formatResult = (
    rawResult: Awaited<ReturnType<typeof runCodeModeExec | typeof runWait>>,
    runtime: ToolSearchRuntime | undefined,
    signal?: AbortSignal,
  ) => {
    const result = normalizeCodeModeTimeoutResult(rawResult);
    markCodeModePermissionChangeResult(result, signal);
    const controlResult = formatToolSearchControlResult(result, runtime, {
      terminalBatchStatus: result.status,
      compact: true,
    });
    return recordCodeModeToolOutcome(
      copyInternalToolResultState(controlResult, {
        ...controlResult,
        ...(runtimeRefresh.isRequested() ? { terminate: runtimeRefresh.isPending() } : {}),
      }),
      result,
    );
  };
  const execTool = markCodeModeControlTool({
    name: CODE_MODE_EXEC_TOOL_NAME,
    label: "exec",
    description: createCodeModeExecDescription(ctx, config),
    parameters: Type.Object({
      title: executionTitleSchema({ required: true }),
      // `command` stays runtime-only for hook compatibility. Requiring `code`
      // prevents schema-valid empty calls from constrained models.
      code: Type.String({
        description:
          "Required JavaScript; no TypeScript annotations, Python, shell, `require`, or `import`. Use `return value`; a trailing expression yields `null`.",
      }),
      awaitResults: Type.Optional(
        Type.Boolean({
          description:
            "Required task results: keep this call owned through event-driven tool waits, without model polling. Explicit background services stay detached. Guest budget and run/tool deadlines still apply.",
        }),
      ),
      restartSafe: Type.Optional(
        Type.Boolean({
          description:
            "Do not set on a new exec. Set true only when OpenClaw explicitly requests replay after a gateway restart; never for write, edit, exec, or any mutation. True rejects unmarked or namespace surfaces.",
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      runtimeRefresh.assertCurrent();
      // Context closure fences new calls; the supplied signal owns in-flight
      // cancellation so sessions_yield can still finish its initiating handoff.
      ctx.abortSignal?.throwIfAborted();
      const input = readCode(args);
      let runtime: ToolSearchRuntime | undefined;
      const result = await runCodeModeExec({
        toolCallId,
        ctx,
        config,
        resultBudget,
        code: input.code,
        assistantTurnId: getAgentToolAssistantTurnId(),
        restartSafe: ctx.forceRestartSafeTools === true || input.restartSafe,
        awaitResults: input.awaitResults,
        signal,
        onUpdate,
        onRuntime: (value) => {
          runtime = value;
        },
      });
      return formatResult(result, runtime, signal);
    },
  } as AnyAgentTool);
  const waitTool = markCodeModeControlTool({
    name: CODE_MODE_WAIT_TOOL_NAME,
    label: "wait",
    hideFromChannelProgress: true,
    description:
      'Resume only when the outer exec result has status "waiting", using its top-level runId. A completed exec may return a still-running tool operation inside value; manage that operation through its enabled tool in a new exec. Never pass a nested sessionId or process ID to wait.',
    parameters: Type.Object({
      runId: Type.String({
        description:
          'Top-level runId from an exec result with status "waiting", never a nested tool sessionId.',
      }),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      runtimeRefresh.assertActive();
      ctx.abortSignal?.throwIfAborted();
      let runtime: ToolSearchRuntime | undefined;
      const result = await runWait({
        toolCallId,
        ctx,
        runId: readRunId(args),
        signal,
        onUpdate,
        onRuntime: (value) => {
          runtime = value;
        },
      });
      return formatResult(result, runtime, signal);
    },
  } as AnyAgentTool);
  return [execTool, waitTool];
}

type CodeModeCatalogApplyParams = {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  toolExecutionAllow?: ToolSearchToolContext["toolExecutionAllow"];
  directToolNames?: Iterable<string>;
  codeModeSkills?: CodeModeToolContext["codeModeSkills"];
};

/** Compact normal tools behind Code Mode exec/wait controls. */
export function applyCodeModeCatalog(params: CodeModeCatalogApplyParams) {
  const tools = finalizeAgentToolAvailability(params.tools, {
    toolExecutionAllow: params.toolExecutionAllow,
  }).filter(
    (tool) =>
      isCodeModeControlTool(tool) ||
      (tool.name !== TOOL_SEARCH_RAW_TOOL_NAME &&
        tool.name !== TOOL_DESCRIBE_RAW_TOOL_NAME &&
        tool.name !== TOOL_CALL_RAW_TOOL_NAME),
  );
  const directToolNames = new Set(params.directToolNames);
  const compacted = applyToolCatalogCompaction({
    ...params,
    tools,
    enabled: true,
    isVisibleControlTool: isCodeModeControlTool,
    // Code mode never exposes core shell/file tools just because structured
    // search does; only explicitly required, trusted direct tools may remain.
    isVisibleCatalogTool: (tool) =>
      directToolNames.has(tool.name) && isDirectVisibleCatalogTool(tool, directToolNames),
    shouldCatalogTool: (tool) => !isCodeModeControlTool(tool),
  });
  return compacted;
}
