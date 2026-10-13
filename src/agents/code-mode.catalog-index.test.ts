import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await resetCodeModeTestState();
});

function overflowConfig(): OpenClawConfig {
  return {
    agents: {
      entries: { main: {} },
      defaults: {
        imageModel: "openai/gpt-5.6-sol",
        pdfModel: "openai/gpt-5.6-sol",
        mediaModels: {
          image: "openai/gpt-image-1",
          video: "google/veo",
          music: "google/lyria",
        },
      },
    },
    tools: {
      exec: { mode: "full" },
      codeMode: true,
      swarm: true,
      web: { search: { provider: "brave" } },
    },
  };
}

it("keeps the exec description byte-stable when the real catalog overflows", () => {
  const workspaceDir = tempDirs.make("code-mode-catalog-index-");
  const config = overflowConfig();
  const targets = createOpenClawCodingTools({
    config,
    agentId: "main",
    cwd: workspaceDir,
    workspaceDir,
    agentDir: workspaceDir,
    sessionKey: "agent:main:main",
    senderIsOwner: true,
    modelHasVision: true,
    clientCaps: ["ui-commands", "inline-widgets"],
    taskSuggestionDeliveryMode: "gateway",
    githubPublicationAvailable: true,
    authProfileStore: { version: 1, profiles: {} },
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
  const catalogRef = createToolSearchCatalogRef();
  const ctx = { config, agentId: "main", catalogRef };
  const render = (tools: typeof targets) => {
    const compacted = applyCodeModeCatalog({
      ...ctx,
      tools: [...createCodeModeTools(ctx), ...tools],
    });
    return compacted.tools.find((tool) => tool.name === "exec")!.description;
  };
  try {
    const description = render(targets);
    expect(catalogRef.current!.entries.length).toBeGreaterThanOrEqual(45);
    // The prompt never embeds the catalog index, so overflow cannot rewrite it.
    expect(description).not.toContain("Enabled async tool globals");
    expect(description).not.toContain("additional tools omitted");
    expect(description.indexOf("exec {")).toBe(-1);
    // Tool order and catalog composition changes keep the bytes identical.
    expect(render(targets.toReversed())).toBe(description);
    expect(render(targets.slice(0, 3))).toBe(description);
  } finally {
    clearToolSearchCatalog(ctx);
  }
});

it("serves current shell and file signatures through discovery on an overflowing catalog", async () => {
  const workspaceDir = tempDirs.make("code-mode-catalog-discovery-");
  const config = overflowConfig();
  const targets = createOpenClawCodingTools({
    config,
    agentId: "main",
    cwd: workspaceDir,
    workspaceDir,
    agentDir: workspaceDir,
    sessionKey: "agent:main:main",
    senderIsOwner: true,
    modelHasVision: true,
    clientCaps: ["ui-commands", "inline-widgets"],
    taskSuggestionDeliveryMode: "gateway",
    githubPublicationAvailable: true,
    authProfileStore: { version: 1, profiles: {} },
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
  const harness = createCodeModeHarness();
  const compacted = applyCodeModeCatalog({
    ...harness.ctx,
    config,
    tools: [...harness.tools, ...targets],
  });
  const exec = compacted.tools.find((tool) => tool.name === "exec")!;
  const wait = compacted.tools.find((tool) => tool.name === "wait")!;
  try {
    const details = await runUntilCompleted({
      execTool: exec,
      waitTool: wait,
      code: `
        const names = ["exec", "process", "apply_patch", "edit", "ls", "read", "write"];
        const found = [];
        for (const name of names) {
          const [tool] = await catalog.search(name, { limit: 1 });
          const described = await tool.describe();
          found.push({ name: described.name, parameters: described.parameters });
        }
        return found;
      `,
    });
    expect(details.status).toBe("completed");
    const found = details.value as Array<{ name: string; parameters: Record<string, unknown> }>;
    const byName = new Map(found.map((entry) => [entry.name, entry]));
    const propertiesOf = (name: string) => {
      const parameters = byName.get(name)?.parameters as { properties?: object } | undefined;
      return Object.keys(parameters?.properties ?? {});
    };
    expect(propertiesOf("exec")).toEqual(
      expect.arrayContaining(["command", "workdir", "timeoutSeconds"]),
    );
    expect(propertiesOf("process")).toEqual(expect.arrayContaining(["sessionId", "timeout"]));
    for (const name of ["apply_patch", "edit", "ls", "read", "write"]) {
      expect(byName.has(name), `discovery must surface ${name}`).toBe(true);
    }
  } finally {
    await resetCodeModeTestState();
    clearToolSearchCatalog({ catalogRef: harness.catalogRef });
  }
});
