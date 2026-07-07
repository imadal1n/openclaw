// Sandbox prune tests cover runtime removal ordering and registry cleanup
// behavior for stale sandbox entries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPruneConfig } from "./prune.test-fixtures.js";

let maybePruneSandboxes: typeof import("./prune.js").maybePruneSandboxes;

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

describe("maybePruneSandboxes", () => {
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
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "sandbox-1",
          backendId: "docker",
          sessionKey: "agent:main",
          createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
          lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
          image: "openclaw-sandbox:bookworm-slim",
        },
      ],
    });
    backendMocks.removeRuntime.mockResolvedValue(undefined);
    ({ maybePruneSandboxes } = await import("./prune.js"));
  });

  it("removes the registry entry after runtime removal succeeds", async () => {
    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-1");
  });

  it("keeps the registry entry when runtime removal fails", async () => {
    // The registry is the retry source; keep it until the backend confirms the
    // runtime was removed.
    backendMocks.removeRuntime.mockRejectedValueOnce(new Error("docker rm failed"));

    await maybePruneSandboxes(buildPruneConfig());

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove sandbox-1: docker rm failed",
    );
  });

  it("prunes entries with out-of-range registry timestamps", async () => {
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [
        {
          containerName: "sandbox-out-of-range",
          backendId: "docker",
          sessionKey: "agent:main",
          createdAtMs: Date.now(),
          lastUsedAtMs: Number.MAX_SAFE_INTEGER,
          image: "openclaw-sandbox:bookworm-slim",
        },
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-out-of-range");
  });
});
