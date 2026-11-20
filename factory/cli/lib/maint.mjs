// @ts-check
/**
 * Factory maintenance worktrees (FX-NN).
 *
 * A specialist implements a factory change in an isolated worktree of the FACTORY repo
 * (`<worktrees>/_factory/<FX-ID>`, branch `fx/<FX-ID>` from `main`), runs the tests there, commits on the
 * branch and writes `report-a1.json`. An independent reviewer reviews the exact branch head and writes
 * `review-a1.json`. Only the orchestrator merges into `main` (`factory maint merge`), after the CLI has
 * checked provenance, review verdict and head, a clean worktree, a safe root checkout, and re-run the
 * verification commands itself.
 *
 * State: `<state>/maintenance.jsonl` (append-only events, the source of truth) and
 * `<state>/maintenance.json` (derived snapshot, rebuildable). Claims reuse the guard's agent map with
 * `{ game: '_factory', task: <FX-ID>, attempt: 1 }`, so write scopes, the SubagentStop report check and
 * the review-file rules work exactly as for game tasks.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  paths, git, run, readJson, readJsonl, appendJsonl, writeJsonAtomic, writeTextAtomic, ensureDir,
  acquireLock, nowIso, sha256, norm, FactoryError, loadConfig,
} from './core.mjs';
import { FACTORY_AGENTS, baseRole, isFactoryAgent, sameBaseRole, pinFor } from './agents.mjs';
import { assertProvenance, dispatchLine, readReviewJson } from './tasks.mjs';
import { validateReview, reviewConsequences, renderReviewSchema, parseBriefAcceptanceIds } from './review-schema.mjs';
import { withRunPort } from './runs.mjs';
import { releaseClaims } from './claims.mjs';

export const MAINT_GAME = '_factory';
export const FX_ID_RE = /^FX-[0-9A-Z][0-9A-Z-]{0,30}$/;
export const DEFAULT_MAINT_VERIFY = ['node --test factory/cli/test/*.test.mjs'];
const ATTEMPT = 1;

export function maintFiles() {
  const s = paths().state;
  return { log: `${s}/maintenance.jsonl`, snapshot: `${s}/maintenance.json`, lock: `${s}/.maintenance.lock`, mergeLock: `${s}/.maintenance-merge.lock`, evidence: `${s}/maintenance` };
}
export const maintWorktree = (id) => `${paths().worktrees}/${MAINT_GAME}/${id}`;
export const maintBranch = (id) => `fx/${id}`;
export const maintInbox = (id) => `${paths().inbox}/${MAINT_GAME}/${id}`;
export const maintPacket = (id) => `${maintInbox(id)}/packet-a${ATTEMPT}.md`;
export const maintReport = (id) => `${maintInbox(id)}/report-a${ATTEMPT}.json`;
export const maintReview = (id) => `${maintInbox(id)}/review-a${ATTEMPT}.json`;
export const maintVerifyCommands = (cfg = loadConfig()) => cfg.maintenance?.verify ?? DEFAULT_MAINT_VERIFY;

// ---------------------------------------------------------------- state

/** Pure reducer: maintenance events -> { [id]: item }. */
export function reduceMaint(events) {
  /** @type {Record<string, any>} */
  const items = {};
  const need = (id) => {
    if (!items[id]) throw new Error(`Unknown maintenance item ${id}`);
    return items[id];
  };
  for (const ev of events) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'maint.started':
        if (items[d.id]) throw new Error(`Duplicate maintenance item ${d.id}`);
        items[d.id] = {
          id: d.id, title: d.title, status: 'STARTED', agent: d.agent, reviewer: d.reviewer, brief: d.brief, briefSha256: d.briefSha256,
          worktree: d.worktree, branch: d.branch, base: d.base, packet: d.packet, startedAt: ev.ts, verifyFailures: [], merge: null,
        };
        break;
      case 'maint.verify_failed':
        need(d.id).verifyFailures.push({ ts: ev.ts, head: d.head, failed: d.failed, evidence: d.evidence });
        break;
      case 'maint.claim_released': {
        const it = need(d.id);
        it.claimReleases = [...(it.claimReleases || []), { agentId: d.agentId, agentType: d.agentType, attempt: d.attempt, by: d.by, reason: d.reason ?? null, ts: ev.ts }];
        break;
      }
      case 'maint.merged':
        Object.assign(need(d.id), { status: 'MERGED', merge: d.merge, head: d.head, reviewerType: d.reviewer, reviewerAgentId: d.reviewerAgentId, evidence: d.evidence, reconciled: !!d.reconciled, mergedAt: ev.ts });
        break;
      default:
        throw new Error(`Unknown maintenance event ${ev.type}`);
    }
  }
  return items;
}

export function loadMaint() {
  return reduceMaint(readJsonl(maintFiles().log));
}

function commitMaint(type, data, guard) {
  const f = maintFiles();
  const release = acquireLock(f.lock, { staleMs: loadConfig().lockStaleMs });
  try {
    const events = readJsonl(f.log);
    const items = reduceMaint(events);
    if (guard) guard(items);
    const ev = { seq: (events.length ? events[events.length - 1].seq : 0) + 1, ts: nowIso(), type, actor: 'orchestrator', data };
    const next = reduceMaint([...events, ev]); // throws before anything is written if the event is malformed
    appendJsonl(f.log, ev);
    writeJsonAtomic(f.snapshot, next);
    return next[data.id];
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- start

/**
 * @param {string} id
 * @param {{agent?: any, reviewer?: any, brief?: any, title?: any}} opts
 */
export function startMaint(id, opts = {}) {
  const p = paths();
  const cfg = loadConfig();
  if (!FX_ID_RE.test(String(id || ''))) throw new FactoryError(`Maintenance id must match ${FX_ID_RE} (e.g. FX-01).`, ['factory maint start FX-01 --agent tech-architect --brief <file>']);
  const agent = typeof opts.agent === 'string' ? opts.agent : '';
  if (!isFactoryAgent(agent, cfg) || !FACTORY_AGENTS.implementers.includes(baseRole(agent, cfg))) {
    throw new FactoryError(`--agent must be an implementer agent type (${FACTORY_AGENTS.implementers.join(', ')}, or a -retry variant); got "${agent}".`);
  }
  const reviewer = typeof opts.reviewer === 'string' ? opts.reviewer : 'code-reviewer';
  if (!FACTORY_AGENTS.reviewers.includes(reviewer)) throw new FactoryError(`--reviewer must be one of ${FACTORY_AGENTS.reviewers.join(', ')}; got "${reviewer}".`);
  if (sameBaseRole(agent, reviewer, cfg)) throw new FactoryError(`Reviewer ${reviewer} has the same base role as implementer ${agent}; the review must be independent.`);
  if (typeof opts.brief !== 'string' || !fs.existsSync(opts.brief)) throw new FactoryError('--brief <file> is required and must exist (write it first, e.g. .inbox/_factory/<FX-ID>/brief.md).');
  const brief = norm(opts.brief);
  const briefText = fs.readFileSync(brief, 'utf8');
  if (!briefText.trim()) throw new FactoryError(`Brief ${brief} is empty.`);
  const title = (typeof opts.title === 'string' && opts.title.trim()) || briefText.match(/^#\s+(.+)$/m)?.[1].trim() || id;
  const root = p.root;
  if (git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], root, { allowFail: true }).code !== 0) throw new FactoryError(`${root} has no branch main.`);
  if (loadMaint()[id]) throw new FactoryError(`${id} was already started.`, [`factory maint show ${id}`]);
  const wt = maintWorktree(id);
  const branch = maintBranch(id);
  if (fs.existsSync(wt)) throw new FactoryError(`${wt} already exists but is not recorded; inspect it manually (never overwritten).`);
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root, { allowFail: true }).code === 0) throw new FactoryError(`Branch ${branch} already exists in ${root}; inspect it manually (never overwritten).`);
  const base = git(['rev-parse', 'main'], root);
  ensureDir(path.dirname(wt));
  git(['worktree', 'add', '-b', branch, wt, 'main'], root);
  const pin = pinFor(agent, cfg) || { model: null, effort: null };
  const item = { id, title, agent, reviewer, brief, briefSha256: sha256(briefText), worktree: norm(wt), branch, base, packet: maintPacket(id) };
  try {
    writeTextAtomic(item.packet, renderMaintPacket(item, briefText, pin, maintVerifyCommands(cfg)));
    commitMaint('maint.started', item, (items) => { if (items[id]) throw new FactoryError(`${id} was already started.`); });
  } catch (e) {
    // The worktree exists but is not recorded; `factory recover` reports it as maint-unrecorded too.
    throw new FactoryError(`${id}: worktree ${wt} and branch ${branch} were created but recording failed (${/** @type {any} */ (e).message}). Nothing was deleted.`,
      [`A human inspects and removes them (git -C "${root}" worktree remove "${wt}" && git -C "${root}" branch -D ${branch}), then the orchestrator runs maint start ${id} again`]);
  }
  return { id, title, dispatchTo: agent, model: pin.model, effort: pin.effort, reviewer, worktree: item.worktree, branch, base, packet: item.packet, report: maintReport(id), review: maintReview(id) };
}

function renderMaintPacket(it, briefText, pin, verify) {
  const root = paths().root;
  const wt = it.worktree;
  const cdv = verify.map((c) => `cd "${wt}" && ${c}`);
  return [
    `# Factory maintenance packet ${it.id} (attempt ${ATTEMPT})`,
    '',
    `- ${dispatchLine(it.agent, pin.model, pin.effort)}`,
    `- Title: ${it.title}`,
    `- Implementer: ${it.agent}; independent reviewer: ${it.reviewer}; only the orchestrator merges into main`,
    `- Factory repo (read-only for you): \`${root}\` (main at \`${it.base.slice(0, 12)}\`)`,
    `- Worktree (your ONLY writable code location): \`${wt}\``,
    `- Branch: \`${it.branch}\` (from main)`,
    `- Inbox (report and notes): \`${maintInbox(it.id)}/\``,
    `- Report file you must write with the Write tool: \`${maintReport(it.id)}\``,
    `- Brief: \`${it.brief}\` (sha256 ${it.briefSha256.slice(0, 12)}), embedded below`,
    '',
    '## First action',
    `Run: \`node "${root}/factory/cli/factory.mjs" maint claim ${it.id}\` (registers you for this worktree; writes elsewhere are denied; only ${it.agent} may claim).`,
    '',
    '## Rules',
    `- Every shell command starts with \`cd "${wt}" && …\`. git commands must run inside the worktree (the guard refuses git writes elsewhere); never check out or commit on main.`,
    '- Change files only inside the worktree. Do not run state-changing factory CLI commands; tests use their own temp dirs.',
    '- New tests go into new files `factory/cli/test/fx-NN.test.mjs`. Zero external dependencies in the CLI, `// @ts-check`, English only.',
    '- If main moved meanwhile, merge it into your branch inside the worktree (`git merge main`), resolve deliberately, re-run the tests. Only branches that contain main are merged.',
    '',
    '## Brief',
    briefText.trim(),
    '',
    '## Definition of Done',
    `1. All work committed on \`${it.branch}\` in the worktree (no uncommitted or untracked files). Conventional commits: \`<type>(${it.id}): <summary>\`.`,
    `2. These commands pass in the worktree (the CLI re-runs exactly these before merging): ${cdv.map((c) => `\`${c}\``).join(', ')}.`,
    `3. Report written with the Write tool to \`${maintReport(it.id)}\`; \`head\` must be the branch head the reviewer will see (update the report after every rework round):`,
    '```json',
    JSON.stringify({
      id: it.id, attempt: ATTEMPT, agent: it.agent, branch: it.branch, head: '<full sha of your last commit>', summary: 'what changed and why',
      filesChanged: ['factory/...'], testsRun: [{ command: verify[0], result: 'pass', detail: 'N tests, 0 failures' }],
      knownLimitations: [], unresolvedDefects: [], notes: '',
    }, null, 2),
    '```',
    '',
    `## Independent review (for ${it.reviewer})`,
    `- Inspect \`cd "${wt}" && git log main..HEAD --oneline\` and \`git diff main...HEAD\`; read the changed files; run the tests yourself. Do not modify files.`,
    `- Write the review with the Write tool to \`${maintReview(it.id)}\`. \`head\` is the full sha you reviewed (\`git rev-parse HEAD\` in the worktree); any later commit invalidates the review.`,
    `- Self-check before finishing (records nothing): \`node "${root}/factory/cli/factory.mjs" review check "${maintReview(it.id)}" --task ${it.id} --game ${MAINT_GAME}\`; fix every listed problem until it prints OK.`,
    '- ACCEPT only with every criterion met and no critical/major findings; `maint merge` refuses any other ACCEPT.',
    '',
    renderReviewSchema({ taskId: it.id, attempt: ATTEMPT, reviewer: it.reviewer, criteriaIds: parseBriefAcceptanceIds(briefText), maintenance: true }),
    '',
  ].join('\n');
}

/**
 * Validation context of a maintenance review (review-schema.mjs, maintenance profile). Criteria come from the
 * brief when it defines acceptance ids (a heading "Acceptance ..." with `- **AC1** ...` items); otherwise none.
 * @param {string} id
 */
export function maintReviewContext(id) {
  const it = loadMaint()[id];
  if (!it) throw new FactoryError(`Unknown maintenance item ${id}.`, ['factory maint list']);
  const briefText = fs.existsSync(it.brief) ? fs.readFileSync(it.brief, 'utf8') : '';
  return { taskId: id, attempt: ATTEMPT, reviewer: it.reviewer, criteriaIds: parseBriefAcceptanceIds(briefText), maintenance: true };
}

// ---------------------------------------------------------------- claim / list / show (read-only)

/** Printed by `factory maint claim`; the PreToolUse guard registers the claim before the command runs. */
export function claimMaintInfo(id) {
  const it = loadMaint()[id];
  if (!it || it.status !== 'STARTED') throw new FactoryError(`${id} is ${it ? it.status : 'unknown'}; nothing to claim.`);
  return fs.readFileSync(it.packet, 'utf8');
}

/**
 * `factory maint release-claim <FX-ID> [--agent <agentId>] [--reason "..."]` (orchestrator only): the maintenance
 * implementer stopped mid-attempt; release its claim so the same packet can be re-dispatched to a fresh agent.
 * @param {string} id @param {{agentId?: string, reason?: string}} [opts]
 */
export function releaseMaintClaim(id, opts = {}) {
  const it = loadMaint()[id];
  if (!it) throw new FactoryError(`Unknown factory maintenance item ${id}.`);
  const released = releaseClaims(MAINT_GAME, id, { agentId: opts.agentId, reason: opts.reason, by: 'orchestrator' });
  for (const r of released) commitMaint('maint.claim_released', { id, agentId: r.agentId, agentType: r.agentType, attempt: r.attempt, by: 'orchestrator', reason: opts.reason || null });
  return { id, released, next: it.status === 'STARTED' ? `re-dispatch ${it.agent} with ${it.packet}` : `${id} is ${it.status}; no re-dispatch needed` };
}

/**
 * Shown by `maint list/show` for an item whose merge was found in main and recorded without the CLI re-running
 * the verification commands (interrupted `maint merge`): its tests were never verified by the CLI at that head.
 */
export const RECONCILED_LABEL = 'reconciled (unverified)';

export function listMaint() {
  const items = Object.values(loadMaint());
  if (!items.length) return '(no factory maintenance items)';
  return items.map((it) => `${it.id}\t${it.status}${it.reconciled ? ` ${RECONCILED_LABEL}` : ''}\t${it.agent} -> ${it.reviewer}\t${it.branch}\t${it.title}`).join('\n');
}

/** Facts derived from the filesystem (read-only git) plus the next step. */
export function showMaint(id) {
  const it = loadMaint()[id];
  if (!it) throw new FactoryError(`Unknown maintenance item ${id}.`, ['factory maint list']);
  const root = paths().root;
  const facts = { reportWritten: fs.existsSync(maintReport(id)), review: null, branchHead: null, worktreeClean: null, commitsAhead: null, containsMain: null };
  if (fs.existsSync(maintReview(id))) {
    const r = readJson(maintReview(id), null);
    facts.review = r ? { verdict: r.verdict ?? null, head: r.head ?? null } : { verdict: 'UNREADABLE', head: null };
  }
  if (it.status === 'STARTED' && fs.existsSync(it.worktree)) {
    facts.branchHead = git(['rev-parse', it.branch], root, { allowFail: true }).out || null;
    facts.worktreeClean = git(['status', '--porcelain'], it.worktree, { allowFail: true }).out === '';
    facts.commitsAhead = Number(git(['rev-list', '--count', `main..${it.branch}`], root, { allowFail: true }).out || 0);
    facts.containsMain = git(['merge-base', '--is-ancestor', 'main', it.branch], root, { allowFail: true }).code === 0;
  }
  facts.mergedUnrecorded = mergedIntoMainUnrecorded(it);
  const verification = it.status !== 'MERGED' ? null : it.reconciled ? RECONCILED_LABEL : it.evidence ? `verified (${it.evidence})` : 'unknown';
  return { ...it, verification, files: { packet: it.packet, report: maintReport(id), review: maintReview(id) }, facts, next: nextMaintStep(it, facts) };
}

/** STARTED item whose branch has its own commits and is already contained in main (e.g. crash after git merge). */
function mergedIntoMainUnrecorded(it) {
  if (it.status !== 'STARTED') return false;
  const root = paths().root;
  const head = git(['rev-parse', '--verify', '--quiet', `refs/heads/${it.branch}`], root, { allowFail: true }).out;
  if (!head || head === it.base) return false;
  return git(['merge-base', '--is-ancestor', head, 'main'], root, { allowFail: true }).code === 0;
}

/**
 * Recovery findings for `factory recover` / SessionStart: fx worktrees without a recorded item (interrupted
 * `maint start`) and STARTED items whose branch is already merged into main (interrupted `maint merge`).
 */
export function maintFindings() {
  const out = [];
  let items;
  try {
    items = loadMaint();
  } catch (e) {
    return [{ kind: 'maint-log', detail: /** @type {any} */ (e).message, fix: `inspect ${maintFiles().log} (append-only; never edited by agents)` }];
  }
  const dir = `${paths().worktrees}/${MAINT_GAME}`;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (items[name] || !fs.statSync(`${dir}/${name}`).isDirectory()) continue;
      findings(out, 'maint-unrecorded', name, `${dir}/${name}`, `interrupted maint start: a human inspects and removes the worktree and branch fx/${name}, then maint start ${name} again`);
    }
  }
  for (const it of Object.values(items)) {
    if (mergedIntoMainUnrecorded(it)) findings(out, 'maint-merged-unrecorded', it.id, `${it.branch} is already in main but not recorded`, `factory maint merge ${it.id} (re-checks report and review, then records the existing merge)`);
  }
  return out;
}

function findings(out, kind, task, detail, fix) {
  out.push({ game: MAINT_GAME, task, kind, detail, fix });
}

function nextMaintStep(it, f) {
  if (it.status === 'MERGED') {
    return it.reconciled
      ? `done (merged as ${String(it.merge).slice(0, 12)}; ${RECONCILED_LABEL}: the CLI did not re-run the verification at that head; run ${maintVerifyCommands().join('; ')} on main to confirm)`
      : `done (merged as ${String(it.merge).slice(0, 12)})`;
  }
  if (f.mergedUnrecorded) return `${it.branch} is already merged into main but not recorded: factory maint merge ${it.id} records it`;
  if (!f.reportWritten) return `dispatch ${it.agent} with the packet ${it.packet}`;
  if (!f.review) return `dispatch ${it.reviewer} to review ${it.branch} and write ${maintReview(it.id)}`;
  if (f.review.verdict !== 'ACCEPT') return `re-dispatch ${it.agent} with the review findings, then a fresh review by ${it.reviewer}`;
  if (f.branchHead && f.review.head && !String(f.branchHead).startsWith(String(f.review.head).toLowerCase())) return `the branch moved after the review: dispatch ${it.reviewer} again`;
  return `factory maint merge ${it.id} (orchestrator; re-runs verification)`;
}

// ---------------------------------------------------------------- merge (orchestrator only)

function gitPath(wt, name) {
  const p = git(['rev-parse', '--git-path', name], wt);
  return path.isAbsolute(p) ? p : path.join(wt, p);
}

/** Environment for verification runs: FACTORY_* overrides of the caller must not leak into the worktree's tests. */
function isolatedEnv() {
  const env = { CI: '1' };
  for (const k of Object.keys(process.env)) if (/^FACTORY_/i.test(k)) env[k] = '';
  return env;
}

const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

/**
 * Merge `fx/<id>` into `main` of the factory repo with `git merge --no-ff`, refusing unless:
 * the report was written by the recorded agent and describes the current branch head; the review was written by
 * the recorded reviewer (a different base role), says ACCEPT without critical/major findings and covers the
 * current branch head; the worktree is clean and the branch contains main; the root checkout is on main with
 * nothing staged and no modified, untracked or ignored file the merge would overwrite; and the configured
 * verification commands pass in the worktree. A branch already merged into main (interrupted earlier run) is
 * recorded as `reconciled` after the same report/review checks; `maint list/show` label it "reconciled (unverified)"
 * because the CLI did not re-run the verification commands for it.
 * @param {string} id @param {{message?: any}} [opts]
 */
export function mergeMaint(id, opts = {}) {
  const cfg = loadConfig();
  const root = paths().root;
  const it = loadMaint()[id];
  if (!it) throw new FactoryError(`Unknown maintenance item ${id}.`, ['factory maint list']);
  if (it.status === 'MERGED') throw new FactoryError(`${id} is already merged (${String(it.merge).slice(0, 12)}).`);
  const release = acquireLock(maintFiles().mergeLock, { staleMs: 60 * 60 * 1000, timeoutMs: 5000 });
  try {
    // 1. Implementer report (provenance: the recorded agent type).
    const reportFile = maintReport(id);
    if (!fs.existsSync(reportFile)) throw new FactoryError(`No report at ${reportFile}; ${it.agent} must finish and write it.`);
    assertProvenance(reportFile, [it.agent]);
    const rep = readJson(reportFile, null);
    // `taskId` is accepted as an alias of `id` (the game-task schema; FX-01 unifies the schemas).
    if (!rep || (rep.id ?? rep.taskId) !== id) throw new FactoryError(`Report ${reportFile} is invalid (expected "id": "${id}").`);

    // 2. Independent review (provenance: the recorded reviewer; different base role; ACCEPT; covers the head).
    const reviewFile = maintReview(id);
    if (!fs.existsSync(reviewFile)) throw new FactoryError(`No independent review yet: dispatch ${it.reviewer} to write ${reviewFile}.`);
    const w = assertProvenance(reviewFile, [it.reviewer]);
    if (sameBaseRole(w.agentType, it.agent, cfg)) throw new FactoryError(`Review written by ${w.agentType}, the implementer's own role; self-review is not accepted.`);
    // The unified review schema (review-schema.mjs), maintenance profile: `head` required, `testsRun` allowed.
    const parsed = readReviewJson(reviewFile);
    const problems = parsed.ok ? validateReview(parsed.value, maintReviewContext(id)) : [parsed.error];
    if (problems.length) {
      throw new FactoryError(`Review ${reviewFile} invalid (${problems.length} problem(s)):\n  - ${problems.join('\n  - ')}`,
        [`Re-dispatch ${it.reviewer} with the review schema in ${it.packet}; it must pass \`factory review check ${reviewFile} --task ${id} --game ${MAINT_GAME}\` before finishing`]);
    }
    const r = parsed.value;
    if (r.verdict !== 'ACCEPT') throw new FactoryError(`Review verdict is ${r.verdict}: re-dispatch ${it.agent} with the findings in ${reviewFile}, then a fresh review.`);
    const { unmet, serious } = reviewConsequences(r);
    if (serious.length) throw new FactoryError(`Review says ACCEPT but lists ${serious.length} critical/major finding(s); not accepted.`);
    if (unmet.length) throw new FactoryError(`Review says ACCEPT but criteria [${unmet.join(', ')}] are not met; not accepted.`);

    // 3. Report and review both describe the current branch head.
    const head = git(['rev-parse', it.branch], root);
    if (!head.startsWith(r.head.toLowerCase())) throw new FactoryError(`The review covers ${r.head.slice(0, 12)} but ${it.branch} is at ${head.slice(0, 12)}; dispatch ${it.reviewer} again.`);
    if (typeof rep.head !== 'string' || !/^[0-9a-f]{7,40}$/i.test(rep.head) || !head.startsWith(rep.head.toLowerCase())) {
      throw new FactoryError(`${reportFile} describes ${String(rep.head).slice(0, 12)} but ${it.branch} is at ${head.slice(0, 12)}; have ${it.agent} update the report (head, summary, tests) for the final head.`);
    }

    // Interrupted earlier merge: the branch is already in main. Record the existing merge instead of refusing.
    if (mergedIntoMainUnrecorded(it)) {
      const mc = lines(git(['log', '--merges', '--ancestry-path', '--format=%H %P', `${head}..main`], root, { allowFail: true }).out)
        .map((l) => l.split(' ')).find((x) => x[2] === head);
      if (!mc) throw new FactoryError(`${it.branch} is already contained in main, but no merge commit with ${head.slice(0, 12)} as its second parent exists; investigate (fx branches are merged only by \`factory maint merge\`).`);
      commitMaint('maint.merged', { id, merge: mc[0], head, reviewer: w.agentType, reviewerAgentId: w.agentId, evidence: null, reconciled: true });
      return { id, merged: true, reconciled: true, merge: mc[0], head, branch: it.branch, reviewer: w.agentType, next: ['node factory/cli/factory.mjs doctor'] };
    }

    // 4. Worktree and branch.
    if (!fs.existsSync(it.worktree)) throw new FactoryError(`Worktree ${it.worktree} is missing; the branch ${it.branch} still exists.`);
    const onBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], it.worktree);
    if (onBranch !== it.branch) throw new FactoryError(`Worktree ${it.worktree} is on ${onBranch}, not ${it.branch}.`);
    const dirty = git(['status', '--porcelain'], it.worktree);
    if (dirty) throw new FactoryError(`Worktree ${it.worktree} has uncommitted or untracked changes:\n${dirty}`);
    if (!Number(git(['rev-list', '--count', `main..${it.branch}`], root))) throw new FactoryError(`${it.branch} has no commits ahead of main.`);
    if (git(['merge-base', '--is-ancestor', 'main', it.branch], root, { allowFail: true }).code !== 0) {
      throw new FactoryError(`${it.branch} does not contain the current main. ${it.agent} must merge main into the branch in the worktree, re-run the tests, and ${it.reviewer} must review the new head.`);
    }

    // 5. Root checkout: on main, nothing staged, nothing the merge would overwrite.
    const rootBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (rootBranch !== 'main') throw new FactoryError(`The factory checkout ${root} is on ${rootBranch}, not main.`);
    if (fs.existsSync(gitPath(root, 'MERGE_HEAD'))) throw new FactoryError(`A merge is in progress in ${root}; finish or abort it first.`);
    const staged = lines(git(['diff', '--cached', '--name-only'], root));
    if (staged.length) throw new FactoryError(`The factory checkout has staged changes (${staged.join(', ')}); commit or unstage them first.`);
    const incoming = lines(git(['diff', '--no-renames', '--name-only', `main...${it.branch}`], root));
    const onMain = new Set(lines(git(['ls-tree', '-r', '--name-only', 'main'], root)));
    const modified = new Set(lines(git(['diff', '--name-only'], root)));
    // Tracked files modified locally, and any file on disk (untracked OR ignored) at a path main does not track.
    const clash = incoming.filter((f) => modified.has(f) || (!onMain.has(f) && fs.existsSync(path.join(root, f))));
    if (clash.length) throw new FactoryError(`Local changes in ${root} would be overwritten by the merge: ${clash.join(', ')}. Commit, move or discard them deliberately first.`);

    // 6. Verification by the CLI, in the worktree, at exactly the reviewed head.
    const cmds = maintVerifyCommands(cfg);
    const evDir = `${maintFiles().evidence}/${id}/${head.slice(0, 12)}`;
    ensureDir(evDir);
    const results = [];
    // Same per-run port allocation as game runs (FX-03), in case a verify command binds E2E_PORT.
    const port = withRunPort(`maint verify ${id}`, (pr) => {
      for (const [i, c] of cmds.entries()) {
        const res = run(c, { cwd: it.worktree, env: { ...isolatedEnv(), ...pr.env } });
        const log = `${evDir}/verify-${i + 1}.log`;
        fs.writeFileSync(log, `$ ${res.cmd}\nexit ${res.exitCode} in ${res.durationMs}ms (E2E_PORT=${pr.port})\n\n${res.output}`);
        results.push({ cmd: c, ok: res.exitCode === 0, exitCode: res.exitCode, durationMs: res.durationMs, log });
        if (res.exitCode !== 0) break;
      }
      return pr.port;
    });
    const ok = results.length === cmds.length && results.every((x) => x.ok);
    writeJsonAtomic(`${evDir}/verify.json`, { id, head, ts: nowIso(), port, ok, results });
    if (!ok) {
      const failed = results.find((x) => !x.ok);
      commitMaint('maint.verify_failed', { id, head, failed: failed?.cmd, evidence: `${evDir}/verify.json` });
      throw new FactoryError(`Verification failed in ${it.worktree}: "${failed?.cmd}" exited ${failed?.exitCode}. Evidence: ${failed?.log}. Nothing was merged.`, [`Re-dispatch ${it.agent} with the evidence`]);
    }

    // 7. Merge (no fast-forward) with a meaningful message.
    const subject = (typeof opts.message === 'string' && opts.message.trim()) || `merge(${id}): ${it.title}`;
    const body = [
      `Factory maintenance ${id}: ${it.branch} -> main (${Number(git(['rev-list', '--count', `main..${it.branch}`], root))} commit(s)).`,
      `Implementer: ${it.agent}. Independent review: ${w.agentType} ACCEPT at ${head.slice(0, 12)}.`,
      `Verified in the worktree: ${cmds.join('; ')}.`,
      `Brief: ${it.brief} (sha256 ${String(it.briefSha256).slice(0, 12)}).`,
    ].join('\n');
    const m = git(['merge', '--no-ff', '-m', subject, '-m', body, it.branch], root, { allowFail: true });
    if (m.code !== 0) {
      if (fs.existsSync(gitPath(root, 'MERGE_HEAD'))) git(['merge', '--abort'], root, { allowFail: true });
      throw new FactoryError(`git merge failed in ${root}; nothing was merged:\n${m.err || m.out}`);
    }
    const merge = git(['rev-parse', 'HEAD'], root);
    commitMaint('maint.merged', { id, merge, head, reviewer: w.agentType, reviewerAgentId: w.agentId, evidence: `${evDir}/verify.json` });
    return {
      id, merged: true, merge, head, branch: it.branch, reviewer: w.agentType, verify: results.map((x) => `${x.cmd}: ok`),
      next: ['node factory/cli/factory.mjs doctor', 'node factory/cli/factory.mjs template check game-phaser-ts (when template/kit/verify code changed)'],
    };
  } finally {
    release();
  }
}
