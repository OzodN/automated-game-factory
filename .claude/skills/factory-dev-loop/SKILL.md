---
name: factory-dev-loop
description: Orchestrator playbook for MODES C and D — starting development after /start-development, loading the phase plan, running the parallel task loop (start, delegate, submit, verify, review, integrate, retry), phase checkpoints and phase reports. Load whenever a game is DEV_AUTHORIZED or in DEVELOPMENT.
---

# Modes C/D — Development loop playbook

## Dispatch rule (applies to every Agent call below)
Models are pinned in the agent definitions (`factory/config.json` → `models`). **Never pass `model` or `effort` on an Agent call** (the guard denies it). Task attempts go to exactly the agent that `task start` prints as `Dispatch to:` — attempt 1: the task's `agent`; attempts >= 2: `<agent>-retry` (Opus) when that variant exists, otherwise the base agent (e.g. tech-architect). The guard refuses a `task claim` by any other agent type. Reviewers are always the task's base `reviewer`.

## C1. Start (after the human typed `/start-development` and the hook confirmed)
1. `node factory/cli/factory.mjs gate start-development` — freezes the spec, creates `develop`, scaffolds the template + pinned pg-kit, runs a baseline. Read the baseline result; if it failed, report immediately.
2. Dispatch `tech-architect`: "Produce the development plan for game <id> at `.inbox/<id>/plan/plan.json` from the frozen spec (`games/<id>/design/spec/`). 4–6 phases with measurable exit criteria, task DAG per the plan rules, phase 1 starts with a `contracts` task; QA tasks write acceptance tests before features. Run `plan validate`."
3. `node factory/cli/factory.mjs plan load .inbox/<id>/plan/plan.json` (DEV_AUTHORIZED → DEVELOPMENT, phase 1 RUNNING). Before loading, check the plan against the architect's plan rules: e2e/acceptance work split by area into 2–3 tasks with disjoint scopes (L-01; `plan validate` warns `L-01`), no test that forces another task's files to change (FD-05). A `WARNING: L-01` without a written reason in the plan goes back to tech-architect. Tell the human briefly: phases, task counts, phase 1 goal.

## D1. The loop (repeat until the phase checkpoint)
1. `node factory/cli/factory.mjs task next --game <id>` → ready tasks (with `dispatchTo`) + free slots.
2. For each ready task up to the free slots: `node factory/cli/factory.mjs task start <TASK> --game <id>` — it prints `Dispatch to: <agent>`. Then in ONE message dispatch every started task:
   - subagent_type = exactly the `Dispatch to` agent; no `model`, no `effort`
   - prompt: "Execute task <TASK> of game <id>. Your task packet: <packet path>. Follow it exactly: claim first, work only in the worktree, run verify, commit, write the report with the Write tool."
3. When an implementer finishes (you are notified): `node factory/cli/factory.mjs task submit <TASK> --game <id>` → deterministic verification.
   - `ok: false`, `classification: "defect"` → the task is retryable; it will appear in `task next` again (with feedback in the next packet and `dispatchTo` = the `-retry` agent). If `blocked` is set, go to D3.
   - `ok: false`, `infra: true`, `classification: "infrastructure"` → an environment failure (port in use / `EADDRINUSE`, browser missing or failed to launch, `ENOSPC`, install network error; list: `INFRA_SIGNATURES` in `factory/cli/lib/runs.mjs`). The task stays SUBMITTED and **no attempt is consumed** (event `task.verify_infra_failed`, evidence `verify-infra-<k>.json`). Fix the environment if needed, then just re-run `factory task verify <TASK>`; do not re-dispatch the implementer. Ordinary test failures and timeouts are never classified as infrastructure, and signatures count only in the end of the failed step's output (its failure region).
   - Bounded: each attempt gets at most `infraRetriesPerAttempt` (config, default 2) infrastructure-classified runs (`infraRun`/`infraLimit` in the output). The next matching failure is `classification: "repeated-infrastructure"`: a normal VERIFY_FAILED that consumes the attempt (the task's own code likely causes it, e.g. a server that ignores `E2E_PORT`). Continue as for a defect.
   - Every verify/integrate/checkpoint/playtest/release run gets its own free port (`E2E_PORT`, recorded as `port` in the evidence), so runs never collide.
   - "Verification of <TASK> already running (pid N, started …)" → another live process is verifying it (marker `.factory/games/<id>/runs/verify-<TASK>.json`). Wait for it; never start a second verify or submit. `factory recover` shows it as `verifying` while the pid lives and as `submitted-unverified` (re-run `task verify`) once it is dead. If the pid is alive but is not a factory verify (Windows reused the pid after a hard kill), check it (`tasklist /FI "PID eq N"`), then `factory recover --apply --clear-verify-marker <TASK> --game <id>` and re-run `task verify`.
4. Verified tasks: `node factory/cli/factory.mjs task review-packet <TASK> --game <id>` writes `.inbox/<id>/<TASK>/review-packet-a<n>.md` (task, attempt, implementer, diff command, verify evidence, acceptance ids, the exact review schema, output path). Dispatch the task's `reviewer` (no model/effort) with that path only: "Independently review task <TASK> of game <id>. Your review packet: <review packet path>. Follow it exactly and run `factory review check` before finishing." Never paraphrase the schema in the prompt (pilot: `acceptance`/`text`/`fix`/`APPROVE` were refused). Then `node factory/cli/factory.mjs task review <TASK> --game <id>`; it validates strictly and lists every problem at once — on refusal re-dispatch the reviewer with the same packet and the printed problems.
5. Accepted tasks: `node factory/cli/factory.mjs task integrate <TASK> --game <id>` (one at a time). Regression failure → auto-reverted, task returns for a retry; conflicts → task returns with merge instructions.
6. Keep slots busy: start newly ready tasks while others run (`concurrency` tasks per game, `maxActiveAgents` live agents including reviewers; defaults 3 and 4). Do not idle-poll; wait for notifications. If verify runs time out under load, tell the human (OPERATOR-MANUAL "Concurrency and host load").
6a. An agent reports a `[factory]` guard refusal: never ask it (or another agent) to retry it differently. Decide from the refusal: it is correct (the task is out of scope → amend the plan or a corrective task) or it is a factory defect (escalate to the human, fix through factory maintenance).
7. **An agent stopped mid-attempt** (you stopped it with TaskStop, it crashed, or it hung): it never gets SubagentStop, so its claim stays registered and blocks a fresh agent ("already claimed by active agent ..."). Do NOT start a new attempt for this; instead:
   - `node factory/cli/factory.mjs task release-claim <TASK> --game <id> --reason "<why>"` (add `--agent <agentId>` when you know the id). It releases the claim of the current attempt, marks the agent inactive (it no longer counts towards the agent cap, and its writes are denied from now on) and logs `task.claim_released`.
   - Re-dispatch the SAME attempt to a fresh agent: the attempt's `Dispatch to` agent (packet `.inbox/<id>/<TASK>/packet-a<n>.md`), same prompt as step 2; the work already committed in the worktree is preserved.
   - A new attempt (`task start` after a failed submit/review) supersedes older claims automatically: their agents are deactivated and denied, so no release is needed then.
   - Factory maintenance: `node factory/cli/factory.mjs maint release-claim <FX-ID> --reason "<why>"`, then re-dispatch the packet.
   - `factory recover` lists `stale-claims` (superseded/released claims, tasks no longer in progress; `--apply` clears them) and `long-claim` (a live claim held > 3 h: release it only if the agent is really gone).

## D2. Phase checkpoint
When all phase tasks are INTEGRATED (status shows `factory phase checkpoint`):
1. `node factory/cli/factory.mjs phase checkpoint --game <id>` — full regression on develop + data report. If it fails, the phase stays RUNNING: have tech-architect add corrective tasks (`plan load <file> --amend`).
2. Optionally dispatch `qa-engineer` for a QA pass of the phase (`.inbox/<id>/qa/phase-N.md`) when the phase delivered user-visible behavior.
3. Write the narrative report `.inbox/<id>/reports/phase-N-report.md` (English, 12 sections: objective; completed tasks; rejected tasks; integrated work; test results; integration results; architecture changes; defects; performance; remaining risks; acceptance status per exit criterion; recommendation) from the data report + QA pass. No invented numbers.
4. Tell the human (in the human's language, see `Human language` in the session context): what the phase delivered, evidence, defects, risks, recommendation, and the options: `/approve-phase`, `/reject-phase <reason>`, `/request-changes <text>`, `/pause`. If the phase has playable output, give the exact command to try it (`corepack pnpm run build && corepack pnpm run preview` in `.worktrees/<id>/_integration`).
5. **Stop.** No next-phase work before the hook confirms `/approve-phase` and `factory gate approve-phase` succeeds.
- `/request-changes`: tech-architect writes corrective tasks for the current phase → `plan load --amend`; continue the loop; checkpoint again.
- `/reject-phase`: `factory phase reject` then same as request-changes.

## D2a. Plan amendments (corrective tasks, review recommendations for pending tasks, re-planning)
1. Dispatch `tech-architect`: "Write a plan amendment for game <id> at `.inbox/<id>/plan/amend-<slug>.json` (new `tasks` and/or `modify` entries for PENDING tasks, format in your agent definition) and validate it with `plan validate <file> --amend --game <id>`." A review recommendation aimed at a task that has not started yet goes into `modify` (e.g. its `acceptance`), not into a new task.
2. Check it yourself: `node factory/cli/factory.mjs plan validate <file> --amend --game <id>` (read-only, same checks as load; lists the before/after of every modified field).
3. Load it: `node factory/cli/factory.mjs plan load <file> --amend --game <id>`. Tasks that are IN_PROGRESS or later are refused for `modify` (add a corrective task instead); a modification that creates a scope overlap with a parallel task or a same-role review is refused. The `plan.amended` event records before/after per field; the phase data report lists it under "Plan amendments".
4. Tell the human what changed (quote the before/after lines) in the next phase report.

## D3. Blockers (escalate immediately, don't wait for the checkpoint)
When a task is BLOCKED: read `.factory/games/<id>/reports/blocker-<TASK>.md`, analyze the root cause (dispatch tech-architect if technical), write `.inbox/<id>/<TASK>/blocker-analysis.md` (root cause, evidence, attempts, proposed resolution, decision needed), run `node factory/cli/factory.mjs task blocker-note <TASK>`, and present it to the human: `/retry-task <TASK>` (2 more attempts), `/abandon-task <TASK>`, or `/modify-requirements`. Other independent tasks may continue meanwhile. After `/retry-task`, restart with `task start` and dispatch the printed `Dispatch to` agent.

## After the last phase is approved
The game becomes RC_READY → load `factory-release`.
