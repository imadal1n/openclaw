# Sona Patch Migration Plan

This document maps each active patch from the canonical patch inventory to its source-level migration target in the OpenClaw fork.

## Active Patches Migration Mapping

| Patch ID                               | Source File Path (TypeScript)                                  | Function/Class Modified                                         | Migration Target | Migration Complexity | Privacy Classification |
| -------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- | ---------------- | -------------------- | ---------------------- |
| engine-qmd-primary-session-transcripts | packages/memory-host-sdk/src/engine-qmd.ts                     | readdir filter for primary session transcripts                  | fork-source      | trivial              | public                 |
| backend-config-custom-collection-names | packages/memory-host-sdk/src/host/backend-config.ts            | scopeCollectionBase function                                    | fork-source      | trivial              | private                |
| qmd-manager-sessions-main-source-kind  | extensions/memory-core/src/memory/qmd-manager.ts               | collection source kind assignment                               | fork-source      | trivial              | private                |
| dreaming-main-only-workspace           | extensions/memory-core/src/dreaming.ts                         | resolveMemoryDreamingWorkspaces function                        | fork-source      | trivial              | private                |
| memory-wiki-token-aware-search         | extensions/memory-wiki/src/cli.ts                              | buildDigestCandidatePaths and scorePage functions               | fork-source      | moderate             | public                 |
| memory-core-context-flush-target       | extensions/memory-core/src/index.ts                            | MEMORY_FLUSH_TARGET_HINT and relativePath                       | fork-source      | trivial              | private                |
| qmd-manager-index-writer               | extensions/memory-core/src/memory/qmd-manager.ts               | index.yml writer logic                                          | fork-source      | moderate             | public                 |
| startup-mutator-qmd-path-preservation  | N/A (Nix mutator)                                              | N/A                                                             | host-side        | n/a                  | private                |
| qmd-explicit-cuda-selection            | N/A (host package)                                             | N/A                                                             | host-side        | n/a                  | public                 |
| qmd-host-adapter                       | N/A (shim and mounts)                                          | N/A                                                             | host-side        | n/a                  | private                |
| subagent-durable-completed-results     | src/agents/subagent-registry.ts and subagent-registry-state.ts | subagent run persistence and snapshot loading                   | fork-source      | moderate             | public                 |
| libsignal-sessionentry-log-redaction   | N/A (bundled dependency)                                       | N/A                                                             | dependency-patch | n/a                  | public                 |
| memory-flush-scratch-session-isolation | src/agents/agent-runner.ts                                     | runMemoryFlushIfNeeded function                                 | fork-source      | moderate             | public                 |
| queued-turn-replay-guard               | src/agents/agent-runner.ts and src/agents/attempt.ts           | runReplyAgent and guardSessionManager                           | fork-source      | moderate             | public                 |
| pi-transcript-carryover-suppression    | src/compaction.ts, src/agents/pi.ts, src/agents/selection.ts   | installSessionToolResultGuard and continueFromCurrentTranscript | fork-source      | complex              | public                 |

## Patches Staying Outside Fork

The following patches are not migrated to the fork source because they are inherently host-side, dependency-level, or external:

- `qmd-explicit-cuda-selection`: Applied to the host QMD package to enable CUDA without modifying upstream QMD source.
- `qmd-host-adapter`: Involves host-side daemon, shim, and Nix mounts for architecture isolation.
- `startup-mutator-qmd-path-preservation`: Nix-level startup policy for local QMD path management.
- `main-style-shim`: External plugin for Sona-specific prompt shaping.
- `libsignal-sessionentry-log-redaction`: Patches the bundled libsignal dependency in the image to prevent private key leakage in logs.

These are maintained as-is in the dotfiles for operational continuity.
