// @ts-check
/**
 * Reporting: phase data reports (facts only, generated from evidence), status with the next
 * permitted actions, production metrics, and crash recovery reconciliation.
 */
import fs from 'node:fs';
import { paths, git, readJsonl, readJson, FactoryError, loadConfig, pidAlive } from './core.mjs';
import { loadState, listGames, readyTasks, getFocus, gameDir, PRE_DEV_MODES } from './state.mjs';
import { dispatchAgent } from './agents.mjs';
import { describeModification } from './plan.mjs';
import { readAgentMap, liveAgents, staleClaims, claimState, deactivateAgents, AGENT_WINDOW_MS } from './claims.mjs';
import { verifyMarkerState, describeMarker, clearMarkerHint, clearVerifyMarker, removeStaleRunFile, RUN_FILE_GRACE_MS, infraRetryLimit } from './runs.mjs';

const gameRepoP = (g) => `${paths().games}/${g}`;
/** Agent of the task's current (last started) attempt. */
const attemptAgent = (t) => t.attempts[t.attempts.length - 1]?.agent || t.agent;

/** Modifications recorded by plan.amended events, one line per changed field. */
function amendmentLines(tasks) {
  const lines = [];
  for (const t of tasks) for (const a of t.amendments || []) {
    for (const l of describeModification({ id: t.id, changes: a.changes })) lines.push(`- event #${a.seq}${a.source ? ` (${a.source})` : ''}: ${l}`);
  }
  return lines.length ? lines : ['- none'];
}

/** Facts-only phase report section. The orchestrator writes the narrative separately. */
export function renderPhaseData(g, s, p, evidence) {
  const tasks = Object.values(s.tasks).filter((t) => t.phase === p.n);
  const lines = [
    `# Phase ${p.n} — ${p.name}: data report`,
    '',
    `Game: ${g} (${s.title}) · develop HEAD: \`${evidence.head.slice(0, 12)}\` · generated: ${evidence.ts}`,
    '',
    `## 1. Objective\n${p.goal || '(see plan)'}`,
    '',
    '## Exit criteria',
    ...p.exitCriteria.map((c) => `- ${c}`),
    '',
    '## 2. Tasks',
    '| Task | Title | Agent | Reviewer | Attempts | Status | Merge |',
    '|---|---|---|---|---|---|---|',
    ...tasks.map((t) => `| ${t.id} | ${t.title} | ${t.agent} | ${t.reviewer} | ${t.attempts.length} | ${t.status} | ${t.integration?.merge?.slice(0, 10) || '-'} |`),
    '',
    '### Plan amendments to tasks of this phase (before -> after)',
    ...amendmentLines(tasks),
    '',
    '## 3. Rejected attempts',
  ];
  let rej = 0;
  for (const t of tasks) for (const a of t.attempts) {
    if (a.verify && !a.verify.ok) { rej++; lines.push(`- ${t.id} a${a.n}: verification failed — ${a.verify.summary}`); }
    if (a.review && a.review.verdict !== 'ACCEPT') { rej++; lines.push(`- ${t.id} a${a.n}: review rejected (${(a.review.findings || []).length} findings)`); }
    if (a.integration && !a.integration.ok) { rej++; lines.push(`- ${t.id} a${a.n}: integration ${a.integration.conflict ? 'conflict' : 'regression'} — ${a.integration.reason}`); }
  }
  if (!rej) lines.push('- none');
  let diffstat = '';
  try { diffstat = p.baseHead ? git(['diff', '--shortstat', `${p.baseHead}..${evidence.head}`], gameRepoP(g)) : ''; } catch { /* repo moved */ }
  lines.push('', '## 4. Integrated work', `- ${tasks.filter((t) => t.status === 'INTEGRATED').length} task(s) merged into develop; ${diffstat || 'diffstat unavailable'}`,
    '', '## 5. Checkpoint regression results',
    '| Step | Result | Duration |', '|---|---|---|',
    ...evidence.results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${(r.durationMs / 1000).toFixed(1)}s |`),
    '', `Evidence: \`${gameDir(g)}/evidence/phase-${p.n}/\``);
  return lines.join('\n') + '\n';
}

/** The authoritative answer to "what can happen next?". */
export function nextActions(s) {
  const out = [];
  const human = (cmd, why) => out.push({ who: 'human', cmd, why });
  const orch = (cmd, why) => out.push({ who: 'orchestrator', cmd, why });
  // A pause does not matter any more for an abandoned or archived game (FX-15).
  if (s.paused && !['ABANDONED', 'ARCHIVED'].includes(s.mode)) { human('/resume', 'game is paused'); return out; }
  if (s.blockers.length) for (const b of s.blockers) human(`/retry-task ${b.taskId} | /abandon-task ${b.taskId}`, `task blocked: ${b.report}`);
  if (s.openChangeRequest) { orch('update design/spec per change request', s.openChangeRequest.text); human('/approve-spec-change', 'after reviewing the amended spec'); }
  switch (s.mode) {
    case 'IDEATION': orch('produce design/concept/concept-brief.md with designer + analyst', 'ideation'); human('/approve-concept', 'when the concept brief is final'); break;
    case 'CONCEPT_APPROVED': orch('factory spec start', 'begin specification'); break;
    case 'SPEC_DRAFT': orch('produce design/spec/* (GDD, tech, art/audio, Playgama, tests)', 'specification'); human('/approve-spec', 'when the spec is final'); break;
    case 'SPEC_APPROVED': human('/start-development', 'authorizes implementation'); break;
    case 'DEV_AUTHORIZED': orch('factory plan load <plan.json>', 'tech-architect drafts phases + DAG'); break;
    case 'DEVELOPMENT': {
      const p = s.phases.find((x) => x.n === s.currentPhase);
      if (p?.status === 'CHECKPOINT') { human('/approve-phase | /reject-phase <reason> | /request-changes <text>', `phase ${p.n} report ready`); break; }
      const ready = readyTasks(s);
      const t = Object.values(s.tasks);
      for (const x of t.filter((x) => x.status === 'IN_PROGRESS')) orch(`await ${attemptAgent(x)} on ${x.id}, then factory task submit ${x.id}`, 'in progress');
      for (const x of t.filter((x) => x.status === 'SUBMITTED')) {
        const m = verifyMarkerState(s.id, x.id);
        const infra = x.attempts[x.attempts.length - 1]?.infraFailures || [];
        if (m.state === 'live') orch(`wait: verification of ${x.id} is running (${describeMarker(m.marker)})`, 'verifying');
        else orch(`factory task verify ${x.id}`, infra.length
          ? `infrastructure failure (${(infra[infra.length - 1].signatures || []).map((y) => y.id).join(', ')}), ${infra.length}/${infraRetryLimit()} infrastructure run(s) used; attempt not consumed: fix the environment, re-run verify${infra.length >= infraRetryLimit() ? ' (limit reached: the next matching failure consumes the attempt)' : ''}`
          : 'submitted, not verified (interrupted?)');
      }
      for (const x of t.filter((x) => x.status === 'VERIFIED')) orch(`dispatch ${x.reviewer} for ${x.id}, then factory task review ${x.id}`, 'awaiting independent review');
      for (const x of t.filter((x) => x.status === 'ACCEPTED')) orch(`factory task integrate ${x.id}`, 'accepted, not merged');
      for (const x of ready) {
        const n = x.attempts.length + 1;
        orch(`factory task start ${x.id}, then Dispatch to: ${dispatchAgent(x.agent, n)}`, n > 1 ? `retry (attempt ${n})` : 'ready');
      }
      const phaseTasks = t.filter((x) => x.phase === p?.n);
      if (phaseTasks.length && phaseTasks.every((x) => ['INTEGRATED', 'ABANDONED'].includes(x.status))) orch('factory phase checkpoint', 'all phase tasks integrated');
      break;
    }
    case 'RC_READY': orch('factory playtest prepare', 'build release candidate'); break;
    case 'PLAYTEST': human('/approve-playtest | /reject-playtest <issues>', 'after personal playtest'); break;
    case 'PLAYTEST_APPROVED': human('/approve-release <x.y.z>', 'merge to main + tag'); break;
    case 'RELEASE_APPROVED': orch('factory release package', 'build + zip + validate'); break;
    case 'PACKAGED': orch('factory publish covers (real screenshots of the packaged build), then release-manager: publication packet referencing them, then factory publish prepare', 'prepare Playgama'); human('/archive-game', 'optional: archive without publishing'); break;
    case 'PUBLICATION_PREPARED': human('/authorize-publish draft|sandbox|traffic|catalog-update', 'each external op separately'); human('/archive-game', 'when done'); break;
    case 'ABANDONED': human('/archive-game', `abandoned draft (${s.abandoned?.reason ?? 'no reason recorded'}): archive its records and design`); break;
    case 'ARCHIVED': break;
    default: break;
  }
  // FX-15: a draft game can be dropped by the human before development starts.
  if (PRE_DEV_MODES.includes(s.mode)) human('/abandon-game <reason>', 'drop this draft game');
  return out;
}

export function statusText(s, { brief = false } = {}) {
  const t = Object.values(s.tasks);
  const count = (st) => t.filter((x) => x.status === st).length;
  const p = s.phases.find((x) => x.n === s.currentPhase);
  const lines = [
    `GAME ${s.id} "${s.title}" — mode ${s.mode}${s.paused ? ' (PAUSED)' : ''}${p ? ` — phase ${p.n}/${s.phases.length} ${p.name} [${p.status}]` : ''}`,
  ];
  if (t.length) {
    lines.push(`tasks: ${t.length} total · integrated ${count('INTEGRATED')} · in-progress ${count('IN_PROGRESS')} · awaiting-review ${count('VERIFIED')} · accepted ${count('ACCEPTED')} · failed ${count('VERIFY_FAILED') + count('REJECTED') + count('INTEGRATION_FAILED') + count('NEEDS_REBASE')} · blocked ${count('BLOCKED')} · pending ${count('PENDING')}`);
  }
  if (!brief && t.length) {
    for (const x of s.taskOrder.map((id) => s.tasks[id])) {
      lines.push(`  ${x.id.padEnd(10)} P${x.phase} ${x.status.padEnd(18)} ${x.agent.padEnd(18)} a${x.attempts.length}/${x.maxAttempts} ${x.title}`);
    }
  }
  const live = liveAgents().filter(([, a]) => a.game === s.id);
  if (live.length) lines.push(`live agents: ${live.map(([id, a]) => `${id} (${a.agentType}) ${a.task} a${a.attempt ?? '?'}`).join(', ')}`);
  if (s.blockers.length) lines.push(`BLOCKERS: ${s.blockers.map((b) => b.taskId).join(', ')}`);
  if (s.openChangeRequest) lines.push(`OPEN CHANGE REQUEST: ${s.openChangeRequest.text}`);
  const na = nextActions(s);
  if (na.length) {
    lines.push('next permitted actions:');
    for (const a of na) lines.push(`  [${a.who}] ${a.cmd} — ${a.why}`);
  }
  return lines.join('\n');
}

export function factoryOverview({ brief = false } = {}) {
  const games = listGames();
  const focus = getFocus();
  if (!games.length) return 'Factory: no games registered yet. Start with /game-new <id> "<title>" or describe an idea.';
  const lines = [`Factory: ${games.length} game(s); focus = ${focus || '(none)'}; live agents ${liveAgents().length}/${loadConfig().maxActiveAgents ?? 4}`];
  for (const g of games) {
    const s = loadState(g);
    if (brief && g !== focus && s.mode === 'ARCHIVED') continue;
    lines.push((g === focus ? '* ' : '  ') + statusText(s, { brief: brief || g !== focus }).split('\n').join('\n    '));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- metrics

export function metrics() {
  const runs = readJsonl(paths().agentRuns);
  const out = { generated: new Date().toISOString(), games: [], agents: {}, totals: {} };
  for (const g of listGames()) {
    const s = loadState(g);
    const ev = readJsonl(`${gameDir(g)}/events.jsonl`);
    const at = (type) => ev.find((e) => e.type === type)?.ts;
    const tasks = Object.values(s.tasks);
    const attempts = tasks.flatMap((t) => t.attempts);
    const firstPass = tasks.filter((t) => t.status === 'INTEGRATED' && t.attempts.length === 1).length;
    const hrs = (a, b) => (a && b ? +((Date.parse(b) - Date.parse(a)) / 3600000).toFixed(2) : null);
    const gateLatency = s.phases.filter((p) => p.checkpoint && p.approvedAt).map((p) => hrs(p.checkpoint.ts, p.approvedAt));
    out.games.push({
      id: g, mode: s.mode, abandoned: !!s.abandoned,
      cycleHours: hrs(at('game.created'), at('release.packaged') || at('game.archived')),
      ideationToDevHours: hrs(at('game.created'), at('dev.authorized')),
      phases: s.phases.map((p) => ({ n: p.n, name: p.name, status: p.status, hours: hrs(p.startedAt, p.approvedAt || p.checkpoint?.ts) })),
      tasks: tasks.length,
      attempts: attempts.length,
      firstPassRate: tasks.length ? +(firstPass / tasks.length).toFixed(2) : null,
      verifyFailures: attempts.filter((a) => a.verify && !a.verify.ok).length,
      verifyInfraFailures: attempts.reduce((n, a) => n + (a.infraFailures?.length || 0), 0),
      reviewRejections: attempts.filter((a) => a.review && a.review.verdict !== 'ACCEPT').length,
      integrationConflicts: attempts.filter((a) => a.integration?.conflict).length,
      regressionReverts: attempts.filter((a) => a.integration && !a.integration.ok && !a.integration.conflict).length,
      blockers: ev.filter((e) => e.type === 'task.blocked').length,
      humanGateLatencyHours: gateLatency,
      tokens: runs.filter((r) => r.game === g).reduce((a, r) => a + (r.tokens?.total || 0), 0),
    });
  }
  for (const r of runs) {
    const a = (out.agents[r.agentType] ||= { runs: 0, totalMinutes: 0, tokens: 0 });
    a.runs++; a.totalMinutes += (r.durationMs || 0) / 60000; a.tokens += r.tokens?.total || 0;
  }
  for (const a of Object.values(out.agents)) a.totalMinutes = +a.totalMinutes.toFixed(1);
  out.totals = {
    gamesPackaged: out.games.filter((g) => !g.abandoned && ['PACKAGED', 'PUBLICATION_PREPARED', 'ARCHIVED'].includes(g.mode)).length,
    gamesAbandoned: out.games.filter((g) => g.abandoned).length,
    tokens: Object.values(out.agents).reduce((a, x) => a + x.tokens, 0),
    agentRuns: runs.length,
  };
  return out;
}

// ---------------------------------------------------------------- recovery

/**
 * Reconcile persisted state with the filesystem after any interruption.
 * Safe automatic repairs (with --apply): stale locks, aborted merges, stale active-agent entries.
 * Everything else is reported as an explicit next step; nothing is deleted.
 */
export function recover({ apply = false, clearVerifyMarkers = [], game = undefined } = {}) {
  const findings = [];
  // Forcible marker clearing is an explicit operator decision and only happens with --apply.
  const clearMarkers = apply ? clearVerifyMarkers : [];
  const p = paths();
  // Stale active agents (SubagentStop never arrived: crash/restart/TaskStop).
  const amap = readAgentMap();
  const old = (v) => Date.now() - Date.parse(v.startedAt || v.ts) > AGENT_WINDOW_MS;
  // Unclaimed agents: the 3 h rule.
  const stale = Object.entries(amap.agents).filter(([, v]) => v.active && !v.task && old(v));
  if (stale.length) findings.push({ kind: 'stale-agents', detail: `${stale.length} unclaimed agent(s) marked active for >3h`, fix: apply ? 'marked inactive' : 'factory recover --apply marks them inactive' });
  // Claimed agents whose claim is superseded/released or whose task is no longer in progress: regardless of age.
  const sc = staleClaims(amap);
  if (sc.length) {
    findings.push({
      kind: 'stale-claims',
      detail: sc.map((x) => `${x.id} (${x.a.agentType}) ${x.a.game}/${x.a.task} a${x.a.attempt ?? '?'}: ${x.reason}`).join('; '),
      fix: apply ? 'marked inactive' : 'factory recover --apply marks them inactive',
    });
  }
  if (apply) deactivateAgents([...stale.map(([id]) => id), ...sc.map((x) => x.id)]);
  // Live claims older than 3 h are NOT cleared automatically: the agent may still be working.
  for (const [id, v] of Object.entries(amap.agents)) {
    if (!v.active || !v.task || v.game === undefined || !old(v) || claimState(v).state !== 'live') continue;
    findings.push({ game: v.game, task: v.task, kind: 'long-claim', detail: `${id} (${v.agentType}) has held attempt ${v.attempt ?? '?'} for >3h`,
      fix: `if the agent is no longer running: ${v.game === '_factory' ? `factory maint release-claim ${v.task}` : `factory task release-claim ${v.task} --game ${v.game}`} --agent ${id}, then re-dispatch` });
  }
  for (const g of listGames()) {
    const lock = `${gameDir(g)}/.lock`;
    if (fs.existsSync(lock)) {
      const o = readJson(`${lock}/owner.json`, null);
      findings.push({ game: g, kind: 'lock', detail: `state lock held by pid ${o?.pid}`, fix: 'broken if stale (automatic on next write)' });
    }
    const s = loadState(g);
    const iwt = `${p.worktrees}/${g}/_integration`;
    if (fs.existsSync(iwt)) {
      const mh = git(['rev-parse', '--git-path', 'MERGE_HEAD'], iwt, { allowFail: true }).out;
      const mhPath = mh && (mh.match(/^[A-Za-z]:|^\//) ? mh : `${iwt}/${mh}`);
      if (mhPath && fs.existsSync(mhPath)) {
        findings.push({ game: g, kind: 'merge-in-progress', detail: 'integration interrupted mid-merge', fix: 'git merge --abort; re-run factory task integrate' });
        if (apply) git(['merge', '--abort'], iwt, { allowFail: true });
      }
    }
    for (const t of Object.values(s.tasks).filter((x) => x.status === 'IN_PROGRESS')) {
      const n = t.attempts.length;
      const wt = t.worktree;
      const agent = attemptAgent(t);
      if (!wt || !fs.existsSync(wt)) { findings.push({ game: g, task: t.id, kind: 'worktree-missing', detail: wt, fix: 'investigate; the branch still exists in the game repo' }); continue; }
      const dirty = git(['status', '--porcelain'], wt, { allowFail: true }).out;
      const ahead = git(['rev-list', '--count', 'develop..HEAD'], wt, { allowFail: true }).out;
      const report = fs.existsSync(`${p.inbox}/${g}/${t.id}/report-a${n}.json`);
      let fix;
      if (report && !dirty) fix = `factory task submit ${t.id} --game ${g}`;
      else if (Number(ahead) > 0 || dirty) fix = `re-dispatch ${agent} on the SAME worktree to finish attempt ${n} (work preserved${dirty ? ', uncommitted changes present' : ''})`;
      else fix = `re-dispatch ${agent} for attempt ${n} (no work found)`;
      findings.push({ game: g, task: t.id, kind: 'in-progress', detail: `commits ahead ${ahead || 0}, dirty ${!!dirty}, report ${report}`, fix });
    }
    // Integration lock held: a live owner is still integrating (wait); a dead owner left a stale lock.
    const ilock = `${gameDir(g)}/.integration.lock`;
    const il = integrationLockState(ilock);
    if (il.state === 'live') findings.push({ game: g, kind: 'integrating', detail: il.owner ? `integration running, pid ${il.owner.pid} (since ${new Date(il.owner.ts).toISOString()})` : 'integration lock just created (owner being written)', fix: 'wait for it to finish; do not start another integrate' });
    else if (il.state === 'stale') findings.push({ game: g, kind: 'stale-integration-lock', detail: `integration lock of dead pid ${il.owner?.pid ?? '? (no owner)'}`, fix: 'broken automatically by the next factory task integrate (then check the integration evidence)' });
    // SUBMITTED (or VERIFY_FAILED being re-verified): a live run marker means the verification is still running.
    const limit = infraRetryLimit();
    for (const t of Object.values(s.tasks).filter((x) => ['SUBMITTED', 'VERIFY_FAILED'].includes(x.status))) {
      if (clearMarkers.includes(t.id) && (!game || game === g)) {
        const moved = clearVerifyMarker(g, t.id);
        findings.push({ game: g, task: t.id, kind: 'verify-marker-cleared', detail: moved ? `marker moved to ${moved}` : 'no marker present', fix: `factory task verify ${t.id} --game ${g}` });
        continue;
      }
      const m = verifyMarkerState(g, t.id);
      if (m.state === 'live') {
        findings.push({ game: g, task: t.id, kind: 'verifying', detail: `verification running, ${describeMarker(m.marker)}`, fix: `wait; do not re-run verify or submit while it runs. ${clearMarkerHint(g, t.id)}` });
        continue;
      }
      if (t.status !== 'SUBMITTED') continue;
      const infra = t.attempts[t.attempts.length - 1]?.infraFailures || [];
      const detail = m.state === 'stale' ? `verification interrupted (stale marker, ${describeMarker(m.marker)})`
        : infra.length ? `last verification hit an infrastructure failure (${(infra[infra.length - 1].signatures || []).map((x) => x.id).join(', ')}); ${infra.length}/${limit} infrastructure run(s) used, attempt not consumed`
          : 'submitted, no verification running';
      findings.push({ game: g, task: t.id, kind: 'submitted-unverified', detail, fix: `factory task verify ${t.id} --game ${g}` });
      if (apply && m.state === 'stale') removeStaleRunFile(m.file);
    }
  }
  return findings;
}

/**
 * Integration lock (a directory with owner.json, see core acquireLock). A lock without owner.json that is
 * younger than RUN_FILE_GRACE_MS is being created right now, so it counts as live.
 * @returns {{ state: 'none'|'live'|'stale', owner: any }}
 */
export function integrationLockState(lockDir) {
  let st;
  try { st = fs.statSync(lockDir); } catch { return { state: 'none', owner: null }; }
  const owner = readJson(`${lockDir}/owner.json`, null);
  if (owner) return { state: pidAlive(owner.pid) ? 'live' : 'stale', owner };
  return { state: Date.now() - st.mtimeMs < RUN_FILE_GRACE_MS ? 'live' : 'stale', owner: null };
}

export function ensureFactoryInitialized() {
  if (!fs.existsSync(paths().root + '/factory/cli/factory.mjs')) throw new FactoryError('Factory root not found.');
}
