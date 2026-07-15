// Tests for the operator-only `openclaw memory add` CLI.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { spyRuntimeErrors, spyRuntimeLogs } from "openclaw/plugin-sdk/test-fixtures";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn(() => ({})));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
);
const resolveMemoryBackendConfig = vi.hoisted(() => vi.fn());

vi.mock("../cli.host.runtime.js", async () => {
  const runtimeCli = await import("openclaw/plugin-sdk/memory-core-host-runtime-cli");
  return {
    defaultRuntime: runtimeCli.defaultRuntime,
    formatErrorMessage: runtimeCli.formatErrorMessage,
    getMemorySearchManager,
    getRuntimeConfig,
    resolveCommandSecretRefsViaGateway,
    resolveDefaultAgentId,
    resolveMemoryBackendConfig,
    shortenHomePath: runtimeCli.shortenHomePath,
    theme: runtimeCli.theme,
    withManager: runtimeCli.withManager,
  };
});

let registerMemoryCli: typeof import("../cli.js").registerMemoryCli;
let defaultRuntime: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").defaultRuntime;
let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("../cli.js"));
  ({ defaultRuntime } = await import("openclaw/plugin-sdk/memory-core-host-runtime-cli"));
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-add-cli-"));
});

beforeEach(() => {
  getMemorySearchManager.mockReset();
  getRuntimeConfig.mockReset().mockReturnValue({});
  resolveDefaultAgentId.mockReset().mockReturnValue("main");
  resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  }));
  resolveMemoryBackendConfig.mockReset().mockReturnValue({
    backend: "skw",
    skw: { effective: { writable: true } },
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

type MemoryWriteParams = {
  eventId: string;
  content: string;
  metadata?: { category: "user_pref" | "general" };
};

function makeSkwManager(memoryWrite?: Mock<(params: MemoryWriteParams) => Promise<void>>) {
  return {
    memoryWrite,
    status: () => ({ backend: "skw" }),
    close: vi.fn(async () => {}),
  };
}

async function runMemoryCli(args: string[]) {
  const program = new Command();
  program.name("test");
  registerMemoryCli(program);
  await program.parseAsync(["memory", ...args], { from: "user" });
}

async function writeContentFile(content: string, suffix = ".md"): Promise<string> {
  const filePath = path.join(fixtureRoot, `case-${caseId++}${suffix}`);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function expectUnsupported(args: string[]) {
  const error = spyRuntimeErrors(defaultRuntime);
  await runMemoryCli(args);
  expect(error).toHaveBeenCalledWith("Memory add requires a writable SKW backend.");
  expect(process.exitCode).toBe(1);
}

describe("memory add cli", () => {
  it("writes content from a regular file to a writable SKW backend", async () => {
    const filePath = await writeContentFile("operator note");
    const memoryWrite = vi.fn(async (_params: MemoryWriteParams) => {});
    getMemorySearchManager.mockResolvedValue({ manager: makeSkwManager(memoryWrite) });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["add", "--target", "user", "--content-file", filePath]);

    expect(memoryWrite).toHaveBeenCalledTimes(1);
    expect(memoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "operator note",
        metadata: { category: "user_pref" },
      }),
    );
    const eventId = memoryWrite.mock.calls[0]?.[0]?.eventId;
    expect(typeof eventId).toBe("string");
    expect(eventId).toHaveLength(36);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Memory add complete"));
    expect(process.exitCode).toBeUndefined();
  });

  it("uses explicit --agent without falling back to the default agent", async () => {
    const filePath = await writeContentFile("agent note");
    const memoryWrite = vi.fn(async (_params: MemoryWriteParams) => {});
    getMemorySearchManager.mockResolvedValue({ manager: makeSkwManager(memoryWrite) });

    await runMemoryCli([
      "add",
      "--agent",
      "custom",
      "--target",
      "general",
      "--content-file",
      filePath,
    ]);

    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(getMemorySearchManager).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "custom" }),
    );
    expect(memoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "agent note",
        metadata: { category: "general" },
      }),
    );
  });

  it("supports general target", async () => {
    const filePath = await writeContentFile("general note");
    const memoryWrite = vi.fn(async (_params: MemoryWriteParams) => {});
    getMemorySearchManager.mockResolvedValue({ manager: makeSkwManager(memoryWrite) });

    await runMemoryCli(["add", "--target", "general", "--content-file", filePath]);

    expect(memoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "general note",
        metadata: { category: "general" },
      }),
    );
  });

  it("rejects unsupported backends before reading the file", async () => {
    resolveMemoryBackendConfig.mockReturnValue({ backend: "builtin" });
    const filePath = await writeContentFile("should not be read");

    await expectUnsupported(["add", "--target", "user", "--content-file", filePath]);
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("rejects QMD backend before reading the file", async () => {
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      qmd: { effective: { writable: true } },
    });
    const filePath = await writeContentFile("should not be read");

    await expectUnsupported(["add", "--target", "user", "--content-file", filePath]);
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("rejects read-only SKW before reading the file", async () => {
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "skw",
      skw: { effective: { writable: false } },
    });
    const filePath = await writeContentFile("should not be read");

    await expectUnsupported(["add", "--target", "user", "--content-file", filePath]);
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("rejects a missing content file", async () => {
    const missingPath = path.join(fixtureRoot, "missing.md");

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["add", "--target", "user", "--content-file", missingPath]);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("Content file not found"));
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects a directory content file", async () => {
    const dirPath = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dirPath, { recursive: true });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["add", "--target", "user", "--content-file", dirPath]);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("not a regular file"));
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects an oversized content file", async () => {
    const filePath = await writeContentFile("x".repeat(16 * 1024 + 1));

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["add", "--target", "user", "--content-file", filePath]);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("exceeds"));
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects an invalid target", async () => {
    const filePath = await writeContentFile("note");

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["add", "--target", "bogus", "--content-file", filePath]);

    expect(error).toHaveBeenCalledWith("--target must be user or general.");
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects a manager without memoryWrite", async () => {
    const filePath = await writeContentFile("note");
    getMemorySearchManager.mockResolvedValue({
      manager: { status: () => ({ backend: "skw" }), close: vi.fn(async () => {}) },
    });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["add", "--target", "user", "--content-file", filePath]);

    expect(error).toHaveBeenCalledWith("Memory add is not supported by the current backend.");
    expect(process.exitCode).toBe(1);
  });

  it("surfaces memoryWrite errors without mutating provider state", async () => {
    const filePath = await writeContentFile("note");
    const memoryWrite = vi.fn(async () => {
      throw new Error("provider denied write");
    });
    getMemorySearchManager.mockResolvedValue({ manager: makeSkwManager(memoryWrite) });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["add", "--target", "user", "--content-file", filePath]);

    expect(memoryWrite).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory add failed"));
    expect(process.exitCode).toBe(1);
  });

  it("surfaces a missing manager without retrying", async () => {
    const filePath = await writeContentFile("note");
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "skw unavailable" });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["add", "--target", "user", "--content-file", filePath]);

    expect(log).toHaveBeenCalledWith("skw unavailable");
  });
});
