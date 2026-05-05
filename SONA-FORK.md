# Sona Fork Documentation

## Current reality — 2026-05-05

The Sona OpenClaw fork is maintained as a **local/Gitea-only** fork. GitHub `origin` remains configured only as a public upstream/fork reference; it must not receive Sona-specific branches, tags, or patch history unless Mădălin explicitly approves a specific public-safe publication.

No cutover is planned. This repository state is a cold/standby fork workflow, not a live deployment instruction.

## Remotes

- `upstream`: `git@github.com:openclaw/openclaw.git` — canonical upstream OpenClaw.
- `origin`: `git@github.com:imadal1n/openclaw.git` — GitHub fork, currently scrubbed of Sona-specific refs.
- `gitea`: `ssh://git@10.10.100.77:2222/limax/openclaw.git` — canonical private Sona fork remote.

## Branches

- `sona-dev`: primary Sona integration branch, based on `lts` and carrying Sona patch work.
- `lts`: stable Sona branch based on upstream `v2026.5.4`, preserved locally and in Gitea as a validated standby line.
- `import/<version>`: temporary branch for rebasing Sona patches onto a newer upstream tag.

There is no Sona `dev` branch. Use `sona-dev` whenever older notes or upstream terminology say "dev".

## Tags

- Naming convention: `sona/lts/YYYY-MM-DD-version`
- Current tag: `sona/lts/2026-05-05-2026.5.4`
- Sona tags are preserved locally and in Gitea only.

## Publication policy

- Push Sona branches and Sona tags to `gitea` only.
- Do not push `lts`, `sona-dev`, or `sona/lts/*` to GitHub `origin`.
- If a patch is later approved for public upstreaming, publish that patch through a deliberately scrubbed public branch or PR, not by mirroring the Sona fork history.
