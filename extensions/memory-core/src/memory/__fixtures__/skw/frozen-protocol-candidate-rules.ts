import { failureCodes, successOperations } from "./frozen-protocol-fixture-cases.js";
import { isKnownValue, isRecord } from "./frozen-protocol-validation-primitives.js";

export function validateCandidate(
  record: Record<string, unknown>,
  profiles: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const request = record.request;
  if (!isRecord(request)) {
    errors.push("request envelope missing");
    return errors;
  }
  const operation = request.operation;
  const profile = request.profile;
  if (request.version !== 1) {
    errors.push("request version must be 1");
  }
  if (!isKnownValue(operation, successOperations)) {
    errors.push("request operation is unknown");
  }
  if (typeof profile !== "string" || !profiles.has(profile)) {
    errors.push("request profile is unknown");
  }
  const response = record.response;
  if (!isRecord(response)) {
    errors.push("response envelope missing");
    return errors;
  }
  if (response.ok === false) {
    validateFailureResponse(response, errors);
    return errors;
  }
  if (response.ok !== true) {
    errors.push("response ok must be true or false");
    return errors;
  }
  if (typeof operation === "string") {
    validateSuccessResponse(operation, response, errors);
  }
  return errors;
}

function validateFailureResponse(response: Record<string, unknown>, errors: string[]): void {
  const error = response.error;
  if (!isRecord(error)) {
    errors.push("failure error object missing");
    return;
  }
  if (!isKnownValue(error.code, failureCodes)) {
    errors.push("failure error code is unknown");
  }
  if (typeof error.message !== "string" || error.message.length === 0) {
    errors.push("failure error message missing");
  }
}

function validateSuccessResponse(
  operation: string,
  response: Record<string, unknown>,
  errors: string[],
): void {
  switch (operation) {
    case "search":
      validateSearchResponse(response, errors);
      return;
    case "read":
      validateReadResponse(response, errors);
      return;
    case "status":
      validateStatusResponse(response, errors);
      return;
    case "probe_embedding":
    case "probe_vector":
      validateProbeResponse(response, errors);
      return;
    default:
      errors.push("success operation is unknown");
  }
}

function validateSearchResponse(response: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(response.results)) {
    errors.push("search results missing");
    return;
  }
  for (const result of response.results) {
    if (!isRecord(result)) {
      errors.push("search result is not an object");
      continue;
    }
    validateSearchResult(result, errors);
  }
}

function validateSearchResult(result: Record<string, unknown>, errors: string[]): void {
  validateOpenClawResultFields(result, errors);
  validateSignedReadPath(result.path, errors);
  if (!isKnownValue(result.source, ["memory", "sessions"] as const)) {
    errors.push("search result source is invalid");
  }
  if (!isKnownValue(result.truthTier, ["verified", "observed", "derived"] as const)) {
    errors.push("search result truth tier is invalid");
  }
  if (!isKnownValue(result.visibility, ["shared", "private"] as const)) {
    errors.push("search result visibility is invalid");
  }
  if (result.source === "sessions") {
    validateSessionArtifact(result.sessionArtifact, errors);
  }
}

function validateOpenClawResultFields(result: Record<string, unknown>, errors: string[]): void {
  if (typeof result.path !== "string") {
    errors.push("OpenClaw search result path missing");
  }
  if (typeof result.startLine !== "number") {
    errors.push("OpenClaw search result startLine missing");
  }
  if (typeof result.endLine !== "number") {
    errors.push("OpenClaw search result endLine missing");
  }
  if (typeof result.score !== "number") {
    errors.push("OpenClaw search result score missing");
  }
  if (typeof result.snippet !== "string") {
    errors.push("OpenClaw search result snippet missing");
  }
}

function validateReadResponse(response: Record<string, unknown>, errors: string[]): void {
  const result = response.result;
  if (!isRecord(result)) {
    errors.push("read result missing");
    return;
  }
  validateSignedReadPath(result.path, errors);
  if (typeof result.text !== "string") {
    errors.push("OpenClaw read result text missing");
  }
  if (result.from !== undefined && typeof result.from !== "number") {
    errors.push("OpenClaw read result from invalid");
  }
  if (result.lines !== undefined && typeof result.lines !== "number") {
    errors.push("OpenClaw read result lines invalid");
  }
  if (
    result.nextFrom !== null &&
    result.nextFrom !== undefined &&
    typeof result.nextFrom !== "number"
  ) {
    errors.push("OpenClaw read result nextFrom invalid");
  }
}

function validateStatusResponse(response: Record<string, unknown>, errors: string[]): void {
  const status = response.status;
  if (!isRecord(status)) {
    errors.push("status result missing");
    return;
  }
  if (status.backend !== "skw") {
    errors.push("status backend must be skw");
  }
  if (typeof status.provider !== "string") {
    errors.push("status provider missing");
  }
  if (!isRecord(status.custom)) {
    errors.push("status custom missing");
  }
}

function validateProbeResponse(response: Record<string, unknown>, errors: string[]): void {
  if (typeof response.available !== "boolean") {
    errors.push("probe availability missing");
  }
}

function validateSignedReadPath(value: unknown, errors: string[]): void {
  if (typeof value !== "string" || !value.startsWith("skw://") || !value.includes("sig=")) {
    errors.push("read path is not a signed skw path");
  }
  if (
    typeof value === "string" &&
    (value.startsWith("qmd://") || value.startsWith("/") || value.startsWith("../"))
  ) {
    errors.push("read path uses forbidden raw or qmd scheme");
  }
}

function validateSessionArtifact(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("session artifact missing");
    return;
  }
  if (value.agentId !== "fixture-agent") {
    errors.push("session artifact agent is invalid");
  }
  if (typeof value.archived !== "boolean") {
    errors.push("session artifact archived missing");
  }
  if (typeof value.memoryKey !== "string" || value.memoryKey.length === 0) {
    errors.push("session artifact memoryKey missing");
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    errors.push("session artifact sessionId missing");
  }
}
