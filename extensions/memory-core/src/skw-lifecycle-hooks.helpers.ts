// Helpers for memory-core SKW lifecycle hooks.
import { createHash } from "node:crypto";
import type { EndSessionParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PluginHookSessionEndReason } from "openclaw/plugin-sdk/plugin-entry";

export type SkwSessionEndReason = "reset" | "new" | "archive" | "shutdown" | "other";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function stableUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export function resolveAgentEndEventId(params: {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
}): string {
  if (params.runId && isUuid(params.runId)) {
    return params.runId;
  }
  const seed = [
    params.runId?.trim() ?? "",
    params.sessionId?.trim() ?? "",
    params.sessionKey?.trim() ?? "",
  ]
    .filter(Boolean)
    .join(":");
  return stableUuid(seed || "agent-end");
}

export function mapSessionEndReason(reason?: PluginHookSessionEndReason): SkwSessionEndReason {
  switch (reason) {
    case "reset":
      return "reset";
    case "new":
      return "new";
    case "compaction":
    case "deleted":
      return "archive";
    case "shutdown":
    case "restart":
      return "shutdown";
    default:
      return "other";
  }
}

export function buildSessionEndContext(params: {
  event: {
    sessionId: string;
    sessionKey?: string;
    reason?: PluginHookSessionEndReason;
    nextSessionId?: string;
    nextSessionKey?: string;
  };
}): EndSessionParams {
  return {
    sessionId: params.event.sessionId,
    sessionKey: params.event.sessionKey,
    reason: mapSessionEndReason(params.event.reason),
    nextSessionId: params.event.nextSessionId,
    nextSessionKey: params.event.nextSessionKey,
  };
}

export function normalizeMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = (block as { text: string }).text.trim();
      if (text) {
        texts.push(text);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

export function normalizeMessage(message: unknown): { role: string; text: string } | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  if (role === "system") {
    return undefined;
  }
  const text = normalizeMessageText(message);
  if (!text) {
    return undefined;
  }
  const roleLabel = typeof role === "string" && role.trim() ? role : "unknown";
  return { role: roleLabel, text };
}

export function normalizeMessages(messages: readonly unknown[]): { role: string; text: string }[] {
  const result: { role: string; text: string }[] = [];
  for (const message of messages) {
    const normalized = normalizeMessage(message);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}
