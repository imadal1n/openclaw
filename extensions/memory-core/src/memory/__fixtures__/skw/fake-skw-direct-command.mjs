import fs from "node:fs/promises";

const manifestUrl = new URL("./frozen-protocol-fixtures.json", import.meta.url);

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(message) {
  return { ok: false, error: { code: "INVALID_REQUEST", message } };
}

const rawManifest = await fs.readFile(manifestUrl, "utf8");
const manifest = JSON.parse(rawManifest);
const stdin = await readStdin();

let request;
try {
  request = JSON.parse(stdin);
} catch {
  process.stdout.write(JSON.stringify(invalidRequest("malformed JSON request")));
  process.exit(0);
}

if (!isRecord(manifest) || !Array.isArray(manifest.fixtures) || !Array.isArray(manifest.profiles)) {
  process.stdout.write(JSON.stringify(invalidRequest("fixture manifest is malformed")));
  process.exit(0);
}

if (!isRecord(request) || request.version !== 1 || typeof request.operation !== "string") {
  process.stdout.write(JSON.stringify(invalidRequest("request envelope is malformed")));
  process.exit(0);
}

if (typeof request.profile !== "string" || !manifest.profiles.includes(request.profile)) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: { code: "DENIED", message: "profile denied" } }),
  );
  process.exit(0);
}

const requestBody = isRecord(request.request) ? request.request : {};
const caseName = typeof requestBody.case === "string" ? requestBody.case : null;
const fixture = manifest.fixtures.find(
  (candidate) =>
    isRecord(candidate) &&
    candidate.name === caseName &&
    isRecord(candidate.request) &&
    candidate.request.operation === request.operation &&
    candidate.request.profile === request.profile,
);

if (!isRecord(fixture) || !isRecord(fixture.response)) {
  process.stdout.write(JSON.stringify(invalidRequest("fixture case not found")));
  process.exit(0);
}

process.stdout.write(JSON.stringify(fixture.response));
