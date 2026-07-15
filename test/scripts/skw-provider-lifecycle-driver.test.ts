// Lifecycle driver tests for scripts/e2e/skw-provider-lifecycle-driver.mjs.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const driverPath = path.resolve("scripts/e2e/skw-provider-lifecycle-driver.mjs");
const fakeProviderPath = path.resolve(
  "scripts/e2e/lib/skw-provider-lifecycle-driver/fake-provider.mjs",
);
const realProviderCommand = [
  path.resolve("/home/limax/work/shared-knowledge-workspace/.venv/bin/python"),
  "-m",
  "skw.openclaw_provider",
].join(" ");

const SHORT_TIMEOUT = "5000";
const fakeProviderCommand = `${process.execPath} ${fakeProviderPath}`;

function runDriver(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", driverPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

function runWithFakeProvider(args: string[], env: Record<string, string>) {
  return runDriver(["--provider-command", fakeProviderCommand, ...args], env);
}

describe("skw-provider-lifecycle-driver", () => {
  it("passes with a strict fake provider", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "strict",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("allPassed");
    expect(result.stderr).toContain("PASS");
  });

  it("fails with a malformed provider response", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "malformed",
      FAKE_PROVIDER_FAULT_OP: "search",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/invalid JSON|malformed/i);
  });

  it("fails when provider times out", () => {
    const result = runWithFakeProvider(["--expect-all-operations", "--request-timeout-ms", "500"], {
      FAKE_PROVIDER_MODE: "timeout",
      FAKE_PROVIDER_FAULT_OP: "prefetch",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/timed out/i);
  });

  it("fails when provider crashes during lifecycle", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "crash",
      FAKE_PROVIDER_FAULT_OP: "agentEnd",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/provider|exitCode|closed/i);
  });

  it("fails when provider responds late", () => {
    const result = runWithFakeProvider(["--expect-all-operations", "--request-timeout-ms", "300"], {
      FAKE_PROVIDER_MODE: "late",
      FAKE_PROVIDER_FAULT_OP: "read",
      FAKE_PROVIDER_FAULT_DELAY_MS: "5000",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/timed out/i);
  });

  it("fails when provider sends duplicate responses", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "duplicate",
      FAKE_PROVIDER_FAULT_OP: "memoryWrite",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/duplicate|expected one response|unexpected response id/i);
  });

  it("fails when provider rejects cross-session identity", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "cross-session",
      FAKE_PROVIDER_FAULT_OP: "search",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/DENIED|session/i);
  });

  it("fails when provider reports dirty attribution", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "dirty-attribution",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no builtin fallback|source/i);
  });

  it("fails when provider returns misleading success", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "misleading-success",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/old session|cleanup|endSession/i);
  });

  it("fails when provider text contains prompt injection", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "prompt-injection",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/prompt injection/i);
  });

  it("still passes when provider does not exit after shutdown (pool kills child)", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "no-close",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("allPassed");
  });

  it("passes when provider exits on SIGINT during close", () => {
    const result = runWithFakeProvider(["--expect-all-operations"], {
      FAKE_PROVIDER_MODE: "sigint",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("allPassed");
  });

  it("fails with a non-existent provider command", () => {
    const result = runDriver(
      ["--expect-all-operations", "--provider-command", "/nonexistent/provider"],
      {},
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/provider command not found|failed to spawn|ENOENT|UNAVAILABLE/i);
  });

  it("passes against the real shared provider command", () => {
    const result = runDriver(
      [
        "--provider-command",
        realProviderCommand,
        "--expect-all-operations",
        "--request-timeout-ms",
        SHORT_TIMEOUT,
      ],
      {},
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("allPassed");
    expect(result.stderr).toContain("PASS");
  });
});

// Smoke test: ensure the provider command argument is forwarded to the child.
it("accepts an explicit provider command argument", () => {
  const command = `${process.execPath} ${fakeProviderPath}`;
  const result = runDriver(["--provider-command", command, "--expect-all-operations"], {
    FAKE_PROVIDER_MODE: "strict",
  });
  expect(result.status).toBe(0);
});
