# Sona Patch Privacy Classification

This document classifies each active patch as public (can be upstreamed) or private (Sona-specific).

Based on the canonical patch inventory class:

- upstream-debt: public

- product-customization: private

| Patch ID                               | Privacy Classification | Rationale             |
| -------------------------------------- | ---------------------- | --------------------- |
| engine-qmd-primary-session-transcripts | public                 | upstream-debt         |
| backend-config-custom-collection-names | private                | product-customization |
| qmd-manager-sessions-main-source-kind  | private                | product-customization |
| dreaming-main-only-workspace           | private                | product-customization |
| memory-wiki-token-aware-search         | public                 | upstream-debt         |
| memory-core-context-flush-target       | private                | product-customization |
| qmd-manager-index-writer               | public                 | upstream-debt         |
| startup-mutator-qmd-path-preservation  | private                | product-customization |
| qmd-explicit-cuda-selection            | public                 | upstream-debt         |
| qmd-host-adapter                       | private                | product-customization |
| subagent-durable-completed-results     | public                 | upstream-debt         |
| libsignal-sessionentry-log-redaction   | public                 | upstream-debt         |
| memory-flush-scratch-session-isolation | public                 | upstream-debt         |
| queued-turn-replay-guard               | public                 | upstream-debt         |
| pi-transcript-carryover-suppression    | public                 | upstream-backport     |
