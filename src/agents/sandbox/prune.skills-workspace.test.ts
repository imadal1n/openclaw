import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPruneConfig } from "./prune.test-fixtures.js";
import type { SandboxRegistryEntry } from "./registry.js";
import { resolveSandboxWorkspaceDir } from "./shared.js";

let maybePruneSandboxes: typeof import("./prune.js").maybePruneSandboxes;

const { TEST_STATE_DIR, SANDBOX_STATE_DIR } = vi.hoisted(() => {
  const nodePath = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(nodePath.join(tmpdir(), "openclaw-sandbox-skills-prune-"));

  return {
    TEST_STATE_DIR: baseDir,
    SANDBOX_STATE_DIR: nodePath.join(baseDir, "sandbox"),
  };
});

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

const backendMocks = vi.hoisted(() => ({
  removeRuntime: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  readRegistry: vi.fn(),
  removeBrowserRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
}));

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

vi.mock("./backend.js", () => ({
  getSandboxBackendManager: vi.fn(() => backendMocks),
}));

vi.mock("./browser-bridges.js", () => ({
  BROWSER_BRIDGES: new Map(),
}));

vi.mock("./docker-backend.js", () => ({
  dockerSandboxBackendManager: backendMocks,
}));

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  readRegistry: registryMocks.readRegistry,
  removeBrowserRegistryEntry: registryMocks.removeBrowserRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: vi.fn(),
}));

function ordinaryEntry(overrides: Partial<SandboxRegistryEntry> = {}): SandboxRegistryEntry {
  return {
    containerName: "sandbox-1",
    backendId: "docker",
    sessionKey: "agent:network-util",
    createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
    lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
    image: "openclaw-sandbox:bookworm-slim",
    ...overrides,
  };
}

function resolveSkillsWorkspaceDir(sessionKey: string): string {
  return resolveSandboxWorkspaceDir(path.join(SANDBOX_STATE_DIR, "skills-workspaces"), sessionKey);
}

async function seedSkillsWorkspace(sessionKey: string): Promise<string> {
  const workspaceDir = resolveSkillsWorkspaceDir(sessionKey);
  await fs.mkdir(path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills", "demo"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills", "demo", "SKILL.md"),
    "---\nname: demo\n---\n",
    "utf-8",
  );
  return workspaceDir;
}

async function blockSkillsWorkspaceRemoval(workspaceDir: string): Promise<() => Promise<void>> {
  const parentDir = path.dirname(workspaceDir);
  await fs.chmod(parentDir, 0o500);
  return async () => {
    await fs.chmod(parentDir, 0o700);
  };
}

describe("sandbox skills workspace pruning", () => {
  afterAll(async () => {
    await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.resetModules();
    configMocks.getRuntimeConfig.mockReset();
    backendMocks.removeRuntime.mockReset();
    registryMocks.readBrowserRegistry.mockReset();
    registryMocks.readRegistry.mockReset();
    registryMocks.removeBrowserRegistryEntry.mockReset();
    registryMocks.removeRegistryEntry.mockReset();
    runtimeMocks.error.mockReset();

    configMocks.getRuntimeConfig.mockReturnValue({});
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readRegistry.mockResolvedValue({ entries: [ordinaryEntry()] });
    backendMocks.removeRuntime.mockResolvedValue(undefined);
    ({ maybePruneSandboxes } = await import("./prune.js"));
  });

  it("removes the slugged skills workspace after ordinary runtime prune succeeds", async () => {
    const workspaceDir = await seedSkillsWorkspace("agent:network-util");

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-1");
    await expect(fs.access(workspaceDir)).rejects.toThrow();
  });

  it("keeps the slugged skills workspace when runtime removal fails", async () => {
    const workspaceDir = await seedSkillsWorkspace("agent:network-util");
    backendMocks.removeRuntime.mockRejectedValueOnce(new Error("docker rm failed"));

    await maybePruneSandboxes(buildPruneConfig());

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove sandbox-1: docker rm failed",
    );
    await expect(fs.access(workspaceDir)).resolves.toBeUndefined();
  });

  it("keeps the slugged skills workspace when cleanup fails", async () => {
    const workspaceDir = await seedSkillsWorkspace("agent:network-util");
    const restoreSkillsWorkspaceParent = await blockSkillsWorkspaceRemoval(workspaceDir);

    try {
      await maybePruneSandboxes(buildPruneConfig());
    } finally {
      await restoreSkillsWorkspaceParent();
    }

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(expect.stringContaining("sandbox-1"));
    await expect(fs.access(workspaceDir)).resolves.toBeUndefined();
  });

  it("does not remove ordinary skills workspace during browser bridge prune", async () => {
    const workspaceDir = await seedSkillsWorkspace("agent:network-util");
    registryMocks.readBrowserRegistry.mockResolvedValueOnce({
      entries: [
        {
          containerName: "browser-1",
          sessionKey: "agent:main",
          createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
          lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
          image: "openclaw-browser:test",
          cdpPort: 9222,
        },
      ],
    });
    registryMocks.readRegistry.mockResolvedValueOnce({ entries: [] });

    await maybePruneSandboxes(buildPruneConfig());

    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledWith("browser-1");
    await expect(fs.access(workspaceDir)).resolves.toBeUndefined();
  });

  it("preserves a skills workspace while a same-scope sibling remains", async () => {
    const workspaceDir = await seedSkillsWorkspace("agent:network-util");
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [
        ordinaryEntry({ containerName: "sandbox-expired" }),
        ordinaryEntry({
          containerName: "sandbox-live",
          createdAtMs: Date.now(),
          lastUsedAtMs: Date.now(),
        }),
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-expired");
    await expect(fs.access(workspaceDir)).resolves.toBeUndefined();
  });

  it("removes shared skills workspace once after final same-scope stale sibling", async () => {
    const workspaceDir = await seedSkillsWorkspace("agent:network-util");
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [
        ordinaryEntry({ containerName: "sandbox-expired-a" }),
        ordinaryEntry({ containerName: "sandbox-expired-b" }),
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(2);
    expect(registryMocks.removeRegistryEntry).toHaveBeenNthCalledWith(1, "sandbox-expired-a");
    expect(registryMocks.removeRegistryEntry).toHaveBeenNthCalledWith(2, "sandbox-expired-b");
    await expect(fs.access(workspaceDir)).rejects.toThrow();
  });

  it("keeps final registry entry when final shared cleanup fails", async () => {
    const workspaceDir = await seedSkillsWorkspace("agent:network-util");
    const restoreSkillsWorkspaceParent = await blockSkillsWorkspaceRemoval(workspaceDir);
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [
        ordinaryEntry({ containerName: "sandbox-expired-a" }),
        ordinaryEntry({ containerName: "sandbox-expired-b" }),
      ],
    });

    try {
      await maybePruneSandboxes(buildPruneConfig());
    } finally {
      await restoreSkillsWorkspaceParent();
    }

    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-expired-a");
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalledWith("sandbox-expired-b");
    expect(runtimeMocks.error).toHaveBeenCalledWith(expect.stringContaining("sandbox-expired-b"));
    await expect(fs.access(workspaceDir)).resolves.toBeUndefined();
  });
});
