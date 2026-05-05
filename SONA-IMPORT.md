# SONA Import Procedure

## Trigger

New upstream release tag appears

## Import Procedure

1. Fetch upstream: `git fetch upstream --tags`
2. Create import branch: `git checkout -b import/<version> sona-dev`
3. Rebase patches onto new upstream tag: `git rebase v<version>`
4. Resolve conflicts per-patch (using SONA-PATCH-MIGRATION-MAP.md)
5. Build: `pnpm build:docker`
6. Run quarantine gates
7. Record result: promoted, hold, or superseded
8. If promoted → follow SONA-PROMOTION.md
9. If held → document blockers

## Rebase Model

Patches are commits on top of upstream tag, rebased on new tag

## Conflict Resolution Patterns

- Bundle name changed → find new source file name
- Upstream fixed same issue → drop local patch, record in patch-inventory
- Upstream changed adjacent code → adapt patch to new context

## Trigger Model

- Import-to-dev: autonomous (any agent)
- Promote-to-lts: requires observation window + Mădălin awareness
- Cutover: requires Mădălin (runs fr)
