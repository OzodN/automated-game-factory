# Git and release governance (GIT)

| ID | Level | Rule | Check |
|---|---|---|---|
| GIT-01 | MUST | One git repository per game (`games/<id>/`), local only (no remote unless the human adds one). The factory repo never contains game code. | cli |
| GIT-02 | MUST | Branches: `main` = released versions only (tagged `vX.Y.Z`); `develop` = integration; `task/<TASK-ID>` = one task, created from `develop` in its own worktree `.worktrees/<id>/<TASK-ID>/`. | cli |
| GIT-03 | MUST | Design docs (`design/`) are committed on `main` at concept/spec approval; spec changes only via change requests (`spec refreeze` merges main → develop). | cli, hooks |
| GIT-04 | MUST | Only ACCEPTED tasks (deterministic verify + independent review) merge into `develop`, with `--no-ff`, in the dedicated integration worktree, followed by full regression; failures auto-revert (history kept). | cli |
| GIT-05 | MUST | Conflicts abort the merge; the task returns to its implementer to merge `develop` deliberately. No automatic conflict resolution. | cli |
| GIT-06 | MUST | `develop` → `main` only after `/approve-release`, and only if `develop` equals the playtested RC; then an annotated tag. | cli |
| GIT-07 | MUST | Release archives are built from the tag in a detached worktree, zipped deterministically (same input → same sha256) and validated. | cli |
| GIT-08 | MUST | No history rewriting, force pushes, branch or tag deletion by agents; failed task worktrees are preserved until `/abandon-task`. | hooks |
| GIT-09 | MUST | Shared kit versions are immutable (`packages/pg-kit/release/pg-kit-X.Y.Z.tgz`); games vendor a tarball; upgrades are explicit `upgrade-kit` tasks with `allowVendor` + `allowDeps`, verified by that game's full regression. | cli |
| GIT-10 | SHOULD | Commit messages follow Conventional Commits with the task id as scope. | review |
