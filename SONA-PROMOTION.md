# SONA-PROMOTION.md

## Promotion Procedure

1. Prerequisites: All quarantine gates pass

2. **Observation window**: Monitor upstream GitHub issues, Discord, release notes for the specific version for a minimum period (typically 2-5 days). Look for: regressions reported by other operators, breaking changes not in release notes, critical bug fixes pending. This is judgment-based, not timer-based.

3. If observation window reveals no blocking issues → proceed with promotion

4. Create promotion tag: `git tag -a sona/lts/<date>-<upstream-version> -m "Promoted from dev after observation"`

5. Merge `dev` into `lts` (fast-forward preferred, merge commit if needed)

6. Push `lts` and tag to both GitHub and Gitea

7. **Promotion = image is ready for cutover. NOT deployed.** The `lts` image sits on disk, validated, waiting for operator decision.

8. Get explicit Mădălin approval before first-ever cutover (HARD GATE — no auto-deployment)

## Cutover Procedure

1. Prerequisites: `lts` image exists and passed all gates

2. Update `arion-compose.nix` to pin the new `openclawForkSha`

3. Run `nix build --no-link` to validate

4. Run `fr` (Mădălin executes — rule 5)

5. Run post-cutover live validation: memory search, wiki bridge, WhatsApp routing, QMD CUDA, agent exec-host policies

6. If live validation fails → rollback

## Rollback Procedures

1. Image-level rollback: revert `arion-compose.nix` SHA to previous known-good SHA, rebuild, recreate

2. Patch-level rollback: revert specific commit on `lts`, rebuild, recreate

3. Full rollback: checkout previous `sona/lts/<date>` tag, rebuild everything

4. Emergency hotfix on `lts`: cherry-pick fix to `lts`, then backport to `dev`

## Edge Cases

- Upstream force-pushes a tag → refuse silent re-import

- `dev` accumulates broken import → reset `dev` to last known-good upstream sync

- Gitea unreachable during promotion → proceed GitHub-only, queue Gitea sync

- Nix build fails after promotion → promotion is partially complete; reconciliation procedure

- Observation window reveals critical regression → hold promotion, document in `~/infra/openclaw/changes/<year>/<version>/`

## Must NOT Do

- Design any auto-promotion or auto-deployment mechanism

- Conflate promotion with deployment (they are separate steps with separate approval gates)

- Allow rollback without evidence preservation
