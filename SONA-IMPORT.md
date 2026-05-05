# SONA Import Procedure

## Trigger

A new upstream OpenClaw release tag appears.

## Current operating model

Imports are local/Gitea-first. They prepare `sona-dev`; they do not deploy anything and do not imply a future cutover.

## Import Procedure

1. Fetch upstream tags: `git fetch upstream --tags`.
2. Create import branch from `sona-dev`: `git checkout -b import/<version> sona-dev`.
3. Rebase Sona patches onto the new upstream tag: `git rebase v<version>`.
4. Resolve conflicts per patch using `SONA-PATCH-MIGRATION.md`.
5. Build and run quarantine gates against safe lab inputs.
6. Record result: `promoted`, `hold`, or `superseded`.
7. If promoted, follow `SONA-PROMOTION.md` and push only to `gitea`.
8. If held, document blockers in the appropriate infra change note.

## Rebase Model

Sona patches are commits on top of an upstream tag, rebased onto each new upstream tag. `sona-dev` is the integration branch; there is no Sona `dev` branch.

## Conflict Resolution Patterns

- Bundle or source path changed → find the new TypeScript source path before adapting.
- Upstream fixed the same issue → drop the local patch and record the outcome in the patch inventory.
- Upstream changed adjacent code → adapt the patch to the new context and rerun gates.

## Trigger Model

- Import to `sona-dev`: autonomous after normal safety checks.
- Promotion to `lts`: requires quarantine gates plus observation window and Mădălin awareness.
- Cutover/deployment: not planned and not part of this import procedure.

## Forbidden During Import

- Do not run `fr`, `nixos-rebuild`, or any deployment/apply command.
- Do not restart, recreate, or `docker exec` into the live gateway.
- Do not use real WhatsApp/channel state in lab validation.
- Do not push Sona refs to GitHub.
