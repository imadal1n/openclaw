# Sona Patch Privacy Classification

This document classifies active Sona patches for local/Gitea maintenance. It is **not** a publication approval list. The full Sona fork is currently local/Gitea-only, and Sona-specific refs must not be mirrored to GitHub.

The canonical patch inventory class is recorded as rationale. Publication posture is stricter than class: even `public-candidate` patches require a separate scrubbed branch or PR and do not permit mirroring Sona refs.

- `upstream-debt`: potentially public only after explicit scrub/review.
- `product-customization`: private by default.

| Patch ID                               | Privacy Classification | Rationale             |
| -------------------------------------- | ---------------------- | --------------------- |
| engine-qmd-primary-session-transcripts | private                | product-customization |
| backend-config-custom-collection-names | private                | product-customization |
| qmd-manager-sessions-main-source-kind  | private                | product-customization |
| dreaming-main-only-workspace           | private                | product-customization |
| memory-wiki-token-aware-search         | public-candidate       | upstream-debt         |
| memory-core-context-flush-target       | private                | product-customization |
| qmd-manager-index-writer               | public-candidate       | product-customization |
| startup-mutator-qmd-path-preservation  | private                | product-customization |
| qmd-explicit-cuda-selection            | public-candidate       | upstream-debt         |
| qmd-host-adapter                       | private                | product-customization |
| subagent-durable-completed-results     | public-candidate       | upstream-debt         |
| libsignal-sessionentry-log-redaction   | public-candidate       | upstream-debt         |
| memory-flush-scratch-session-isolation | public-candidate       | upstream-debt         |
| queued-turn-replay-guard               | public-candidate       | upstream-debt         |
| pi-transcript-carryover-suppression    | public-candidate       | upstream-backport     |

`public-candidate` means only that the idea may be suitable for public upstreaming after identity/context scrub. It does not permit pushing Sona fork history or refs to GitHub.
