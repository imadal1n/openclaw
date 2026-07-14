import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { validateSkwProtocolFixtureManifest } from "./frozen-protocol-validation-rules.js";

export { validateSkwProtocolFixtureManifest };

export const skwFixtureManifestUrl = new URL("./frozen-protocol-fixtures.json", import.meta.url);
export const skwFakeCommandUrl = new URL("./fake-skw-direct-command.mjs", import.meta.url);

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export async function loadSkwProtocolFixtureManifest(): Promise<unknown> {
  const raw = await fs.readFile(skwFixtureManifestUrl, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}

export async function runSkwFixtureCommand(request: unknown): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, [skwFakeCommandUrl.pathname], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}
