// Shared SKW provider framing primitives, types, and error codes.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1 * 1024 * 1024; // including newline
export const STDERR_RING_BYTES = 64 * 1024;
export const MAX_PENDING_QUEUE = 32;
export const KILL_ESCALATION_MS = 1_000;

export const CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "DENIED",
  "UNAVAILABLE",
  "TIMEOUT",
  "ABORTED",
  "MALFORMED_OUTPUT",
  "OUTPUT_LIMIT",
  "INTERNAL",
] as const;

export type SkwErrorCode = (typeof CODES)[number];

export type SkwProviderIdentity = {
  agentId: string;
  profile: string;
  sessionId?: string;
  sessionKey?: string;
};

export type SkwProviderProcessConfig = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: { warn: (message: string) => void; debug?: (message: string) => void };
};

export class SkwProviderError extends Error {
  constructor(
    public readonly code: SkwErrorCode,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(`SKW ${code}: ${message}`);
  }
}

export function buildFrame(
  id: string,
  op: string,
  identity: SkwProviderIdentity,
  params: Record<string, unknown>,
): Buffer {
  const frame = Buffer.from(
    JSON.stringify({ version: PROTOCOL_VERSION, id, op, identity, params }) + "\n",
    "utf8",
  );
  if (frame.length > MAX_FRAME_BYTES) {
    throw new SkwProviderError("OUTPUT_LIMIT", `outgoing frame exceeded ${MAX_FRAME_BYTES} bytes`);
  }
  return frame;
}

export function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: false });
    return true;
  } catch {
    return false;
  }
}

const RESPONSE_KEYS = new Set(["version", "id", "ok", "result", "error"]);
const ERROR_KEYS = new Set(["code", "message", "retryable"]);

export type SkwWireResult =
  | { id: string; result: unknown }
  | { id: string; error: SkwProviderError };

export function validateWireResponse(value: unknown): SkwWireResult {
  if (typeof value !== "object" || value === null) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "response is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RESPONSE_KEYS.has(key)) {
      throw new SkwProviderError("MALFORMED_OUTPUT", `unknown response field: ${key}`);
    }
  }
  if (record.version !== PROTOCOL_VERSION) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "response version mismatch");
  }
  if (typeof record.id !== "string") {
    throw new SkwProviderError("MALFORMED_OUTPUT", "response id is not a string");
  }
  if (record.ok !== true && record.ok !== false) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "response ok is not boolean");
  }
  if (record.ok === true) {
    if ("error" in record) {
      throw new SkwProviderError("MALFORMED_OUTPUT", "success response contains error");
    }
    if (!("result" in record)) {
      throw new SkwProviderError("MALFORMED_OUTPUT", "success response missing result");
    }
    return { id: record.id, result: record.result };
  }
  if ("result" in record) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "error response contains result");
  }
  if (!("error" in record)) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "error response missing error");
  }
  const error = parseErrorRecord(record.error);
  return { id: record.id, error: new SkwProviderError(error.code, error.message, error.retryable) };
}

function parseErrorRecord(value: unknown): {
  code: SkwErrorCode;
  message: string;
  retryable: boolean;
} {
  if (typeof value !== "object" || value === null) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "error is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ERROR_KEYS.has(key)) {
      throw new SkwProviderError("MALFORMED_OUTPUT", `unknown error field: ${key}`);
    }
  }
  if (typeof record.code !== "string" || !(CODES as readonly string[]).includes(record.code)) {
    throw new SkwProviderError("MALFORMED_OUTPUT", "error code is not a recognized code");
  }
  if (typeof record.message !== "string") {
    throw new SkwProviderError("MALFORMED_OUTPUT", "error message is not a string");
  }
  return {
    code: record.code as SkwErrorCode,
    message: record.message,
    retryable: record.retryable === true,
  };
}

export function isErrorRecord(value: unknown): {
  code: SkwErrorCode;
  message: string;
  retryable?: boolean;
} {
  try {
    const parsed = parseErrorRecord(value);
    return parsed;
  } catch {
    return { code: "INTERNAL", message: "unknown provider error", retryable: false };
  }
}
