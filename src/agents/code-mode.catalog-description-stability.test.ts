import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { addClientToolsToToolCatalog, restrictToolSearchCatalog } from "./tool-search-catalog.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

afterEach(async () => {
  await resetCodeModeTestState();
});

function applyWithTools(tools: AnyAgentTool[], sessionKey = "agent:main:stable-session") {
  const harness = createCodeModeHarness();
  const ctx = { ...harness.ctx, sessionKey };
  const compacted = applyCodeModeCatalog({ ...ctx, tools: [...harness.tools, ...tools] });
  const exec = compacted.tools.find((tool) => tool.name === "exec");
  const wait = compacted.tools.find((tool) => tool.name === "wait");
  expect(exec).toBeDefined();
  expect(wait).toBeDefined();
  return { ...harness, ctx, compacted, exec: exec!, wait: wait! };
}

function pluginLlmTask(received: unknown[]) {
  const tool = Object.assign(fakeTool("llm_task", "Trusted plugin helper"), {
    parameters: Type.Object({ secret: Type.String() }),
    execute: async (_toolCallId: string, input: unknown) => {
      received.push(input);
      return jsonResult({ receipt: "plugin-owner" });
    },
  });
  setPluginToolMeta(tool, { pluginId: "trusted-plugin", optional: false });
  return tool;
}

function clientLlmTask(received: unknown[]) {
  return {
    name: "llm_task",
    label: "Client llm_task",
    description: "Client-owned llm_task",
    parameters: Type.Object({ request: Type.String() }),
    execute: async (_toolCallId: string, input: unknown) => {
      received.push(input);
      return jsonResult({ accepted: true });
    },
  } as never;
}

it("keeps the exec description byte-identical across catalog growth, shrink, owner change, and reset", () => {
  const first = applyWithTools([fakeTool("stable_alpha", "First-run tool")]);
  const description = first.exec.description;
  expect(description).not.toContain("stable_alpha");

  // Growth: a late client tool joins the catalog between runs of the session.
  addClientToolsToToolCatalog({
    enabled: true,
    ...first.ctx,
    tools: [
      {
        name: "stable_beta",
        label: "Stable beta",
        description: "Late-joining client tool",
        parameters: Type.Object({}),
        execute: async () => jsonResult({}),
      } as never,
    ],
  });
  expect(first.catalogRef.current?.entries.map((entry) => entry.name)).toContain("stable_beta");
  expect(first.exec.description).toBe(description);

  // Shrink: restriction narrows the live catalog.
  restrictToolSearchCatalog({ ...first.ctx, allowedToolNames: new Set(["stable_alpha"]) });
  expect(first.catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["stable_alpha"]);
  expect(first.exec.description).toBe(description);

  // /new, /reset: a fresh attempt of the same session re-applies its catalog
  // with different content; the tools array the provider sees does not change.
  const reset = applyWithTools([
    fakeTool("stable_alpha", "First-run tool"),
    fakeTool("stable_gamma", "Post-reset tool"),
  ]);
  expect(reset.exec.description).toBe(description);
  expect(reset.exec.description).not.toContain("stable_gamma");
});

it("serves the current contract and owner from discovery after a mid-session collision", async () => {
  const pluginReceived: unknown[] = [];
  const clientReceived: unknown[] = [];
  const first = applyWithTools([pluginLlmTask(pluginReceived)]);
  const description = first.exec.description;
  expect(description).not.toContain("llm_task");
  expect(description).not.toContain("secret");
  expect(description).not.toContain("receipt");

  // The client lands after the first run and takes over the llm_task callable;
  // the prompt is untouched and advertises neither owner's schema.
  addClientToolsToToolCatalog({
    enabled: true,
    ...first.ctx,
    tools: [clientLlmTask(clientReceived)],
  });
  expect(first.exec.description).toBe(description);

  const details = await runUntilCompleted({
    execTool: first.exec,
    waitTool: first.wait,
    code: `
      const [owner] = await catalog.search("llm_task", { limit: 1 });
      const described = await owner.describe();
      const result = await owner({ request: "client-work" });
      return {
        callableName: owner.callableName,
        source: described.source,
        describedName: described.name,
        hasClientSchema: JSON.stringify(described.parameters).includes("request"),
        hasPluginSchema: JSON.stringify(described.parameters).includes("secret"),
        result,
      };
    `,
  });
  expect(details.status).toBe("completed");
  expect(details.value).toEqual({
    callableName: "llm_task",
    source: "client",
    describedName: "llm_task",
    hasClientSchema: true,
    hasPluginSchema: false,
    result: { accepted: true },
  });
  expect(clientReceived).toEqual([{ request: "client-work" }]);
  expect(pluginReceived).toEqual([]);
});

it("resolves a first-turn collision to the client owner without advertising either schema", async () => {
  const pluginReceived: unknown[] = [];
  const clientReceived: unknown[] = [];
  // The client tool arrives with the request before the first exec runs.
  const first = applyWithTools([pluginLlmTask(pluginReceived)]);
  addClientToolsToToolCatalog({
    enabled: true,
    ...first.ctx,
    tools: [clientLlmTask(clientReceived)],
  });

  const details = await runUntilCompleted({
    execTool: first.exec,
    waitTool: first.wait,
    code: `
      const [owner] = await catalog.search("llm_task", { limit: 1 });
      const described = await owner.describe();
      return {
        callableName: owner.callableName,
        source: described.source,
        result: await owner({ request: "first-turn" }),
      };
    `,
  });
  expect(details.status).toBe("completed");
  expect(details.value).toEqual({
    callableName: "llm_task",
    source: "client",
    result: { accepted: true },
  });
  expect(clientReceived).toEqual([{ request: "first-turn" }]);
  expect(pluginReceived).toEqual([]);
  expect(first.exec.description).not.toContain("llm_task");
  expect(first.exec.description).not.toContain("secret");
});
