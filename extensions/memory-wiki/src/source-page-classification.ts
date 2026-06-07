import type { WikiPageSummary } from "./markdown.js";

export function isImmutableImportedSourcePage(page: WikiPageSummary): boolean {
  return (
    page.sourceType === "memory-bridge" ||
    page.sourceType === "memory-bridge-events" ||
    page.sourceType === "memory-unsafe-local" ||
    page.provenanceMode === "unsafe-local"
  );
}
