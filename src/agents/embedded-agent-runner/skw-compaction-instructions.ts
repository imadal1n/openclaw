// Helpers for merging SKW preservation context into embedded compaction instructions.
import type { MemoryMessage } from "../../plugin-sdk/memory-core-host-engine-storage.js";
import type { AgentMessage } from "../runtime/index.js";

export function normalizeAgentMessageText(message: AgentMessage): string | undefined {
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

export function normalizeMessagesToMemoryMessages(
  messages: readonly AgentMessage[],
): MemoryMessage[] {
  const result: MemoryMessage[] = [];
  for (const message of messages) {
    const role = (message as { role?: unknown }).role;
    if (role === "system") {
      continue;
    }
    const text = normalizeAgentMessageText(message);
    if (!text) {
      continue;
    }
    const roleLabel = typeof role === "string" && role.trim() ? role : "unknown";
    result.push({ role: roleLabel, text });
  }
  return result;
}

export function mergeCompactionInstructions(
  customInstructions: string | undefined,
  preservationContext: string | undefined,
): string | undefined {
  const existing = customInstructions ?? "";
  const context = preservationContext ?? "";
  if (!context) {
    return existing.length > 0 ? existing : undefined;
  }
  if (existing.length === 0) {
    return context;
  }
  return `${existing}\n\n${context}`;
}
