# SONA Promotion Procedure

## Current status — no cutover planned

Promotion currently means "preserve a validated standby fork ref in local/Gitea." It does **not** mean deployment, and there is no planned `fr`, rebuild switch, gateway restart, or live cutover from this procedure.

## Promotion Procedure

1. Confirm all quarantine gates pass against safe lab inputs only.
2. Complete the observation window for the exact upstream version: monitor upstream GitHub issues, Discord, and release notes for regressions or pending critical fixes. This is judgment-based, not timer-based.
3. If observation reveals no blocker, fast-forward `lts` from `sona-dev`.
4. Create the promotion tag: `git tag -a sona/lts/<date>-<upstream-version> -m "Promoted from sona-dev after observation"`.
5. Push `lts`, `sona-dev`, and `sona/lts/*` to `gitea` only.
6. Verify GitHub `origin` does not contain Sona-specific refs.
7. Record whether the result is `promoted`, `hold`, or `superseded`.

## What promotion does not do

- It does not touch the live gateway.
- It does not run `fr` or ask Mădălin to run `fr`.
- It does not modify `arion-compose.nix` for a deployment.
- It does not publish Sona refs to GitHub.
- It does not use real WhatsApp/channel state or live gateway containers for proof.

## Dormant cutover note

A future live cutover would be a separate operator-approved plan with its own Oracle/Metis/Momus validation under the local OpenClaw rules. It is explicitly out of scope for the current fork documentation state.

## Rollback Procedures

1. Ref-level rollback: move work back to the previous local/Gitea `sona/lts/*` tag after documenting why.
2. Patch-level rollback: revert the specific commit on `sona-dev`, then re-promote to `lts` only after gates pass again.
3. Emergency hotfix: branch from `lts`, apply the fix, fast-forward `lts`, then backport to `sona-dev`.

## Edge Cases

- Upstream force-pushes a tag → refuse silent re-import and document the mismatch.
- `sona-dev` accumulates broken import state → preserve a backup branch, reset `sona-dev` from the last known-good `lts`, then re-apply needed patches.
- Gitea unreachable during promotion → stop before promotion; do not fall back to GitHub-only publication.
- Observation window reveals critical regression → hold promotion and document blockers in `~/infra/openclaw/changes/<year>/<version>/`.

## Must NOT Do

- Design auto-promotion or auto-deployment.
- Conflate promotion with deployment.
- Push Sona-private refs to GitHub.
- Treat `fr` as a next step for the current state.
- Restart, recreate, or inspect the live gateway as part of promotion.
- Allow rollback without evidence preservation.
