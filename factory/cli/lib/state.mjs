// @ts-check
/**
 * Event-sourced game state.
 * events.jsonl is the single source of truth; state.json is a derived, rebuildable snapshot.
 * The reducer is pure and deterministic: replaying the same events always yields the same state.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  paths, readJsonl, appendJsonl, writeJsonAtomic, acquireLock, nowIso, FactoryError, loadConfig, readJson,
} from './core.mjs';

export const MODES = [
  'IDEATION', 'CONCEPT_APPROVED', 'SPEC_DRAFT', 'SPEC_APPROVED', 'DEV_AUTHORIZED', 'DEVELOPMENT',
  'RC_READY', 'PLAYTEST', 'PLAYTEST_APPROVED', 'RELEASE_APPROVED', 'PACKAGED', 'PUBLICATION_PREPARED', 'ARCHIVED',
  // FX-15: a draft game dropped by the human (/abandon-game). Terminal except for /archive-game.
  'ABANDONED',
];

/** FX-15: modes from which a draft game may be abandoned (never DEV_AUTHORIZED or later). */
export const PRE_DEV_MODES = ['IDEATION', 'CONCEPT_APPROVED', 'SPEC_DRAFT', 'SPEC_APPROVED'];

/** Task statuses that are terminal for scheduling purposes. */
export const TASK_DONE = new Set(['INTEGRATED', 'ABANDONED']);
/** Statuses from which an implementer may start another attempt. */
export const TASK_RETRYABLE = new Set(['VERIFY_FAILED', 'REJECTED', 'INTEGRATION_FAILED', 'NEEDS_REBASE']);

export function gameDir(gameId) {
  return `${paths().gamesState}/${gameId}`;
}

export function initialState(gameId) {
  return {
    id: gameId,
    title: '',
    mode: null,
    paused: false,
    createdAt: null,
    updatedAt: null,
    lastSeq: 0,
    hashes: { concept: null, spec: null, specFrozen: null },
    openChangeRequest: null,
    kitVersion: null,
    phases: [],
    currentPhase: null,
    tasks: {},
    taskOrder: [],
    rc: null,
    release: null,
    publication: { prepared: false, ops: [] },
    decisions: [],
    blockers: [],
  };
}

/** Pure reducer. Validation of *whether* an event is allowed happens before append (see transitions.mjs). */
export function reduce(state, ev) {
  const s = state;
  s.lastSeq = ev.seq;
  s.updatedAt = ev.ts;
  const d = ev.data || {};
  const task = d.taskId ? s.tasks[d.taskId] : null;
  switch (ev.type) {
    case 'game.created':
      s.title = d.title; s.mode = 'IDEATION'; s.createdAt = ev.ts; break;
    case 'concept.approved':
      s.hashes.concept = d.hash; s.mode = 'CONCEPT_APPROVED'; break;
    case 'spec.started':
      s.mode = 'SPEC_DRAFT'; break;
    case 'spec.approved':
      s.hashes.spec = d.hash; s.mode = 'SPEC_APPROVED'; break;
    case 'dev.authorized':
      s.hashes.specFrozen = d.hash; s.mode = 'DEV_AUTHORIZED'; break;
    case 'game.scaffolded':
      s.kitVersion = d.kitVersion; break;
    case 'change.requested':
      s.openChangeRequest = { text: d.text, ts: ev.ts, seq: ev.seq }; break;
    case 'spec.refrozen':
      s.hashes.specFrozen = d.hash; s.hashes.spec = d.hash; s.openChangeRequest = null; break;
    case 'plan.loaded': {
      s.mode = 'DEVELOPMENT';
      s.phases = d.phases.map((p, i) => ({ ...p, status: i === 0 ? 'RUNNING' : 'PLANNED', startedAt: i === 0 ? ev.ts : null, baseHead: i === 0 ? d.baseHead : null }));
      s.currentPhase = s.phases[0]?.n ?? null;
      for (const t of d.tasks) addTask(s, t);
      break;
    }
    case 'plan.amended':
      for (const t of d.tasks || []) addTask(s, t);
      for (const m of d.modified || []) modifyTask(s, m, ev);
      break;
    case 'task.started':
      Object.assign(task, { status: 'IN_PROGRESS', worktree: d.worktree, branch: d.branch, base: d.base });
      task.attempts.push({ n: d.attempt, startedAt: ev.ts, model: d.model || null, agent: d.agent || task.agent });
      break;
    case 'task.claim_released': {
      // Informational (the agent map is the claim registry): keep an audit trail on the attempt.
      const a = cur(task);
      if (a) a.claimReleases = [...(a.claimReleases || []), { agentId: d.agentId, agentType: d.agentType, attempt: d.attempt, by: d.by, reason: d.reason ?? null, ts: ev.ts }];
      break;
    }
    case 'task.submitted':
      task.status = 'SUBMITTED';
      cur(task).report = d.report; cur(task).submittedAt = ev.ts; cur(task).commits = d.commits;
      break;
    case 'task.verified':
      task.status = d.ok ? 'VERIFIED' : 'VERIFY_FAILED';
      cur(task).verify = { ok: d.ok, evidence: d.evidence, summary: d.summary };
      break;
    case 'task.verify_infra_failed': {
      // Environment failure (port in use, missing browser, disk full, install network): status unchanged,
      // the attempt is not consumed; the run is kept for the record.
      const a = cur(task);
      a.infraFailures = [...(a.infraFailures || []), { ts: ev.ts, evidence: d.evidence, signatures: d.signatures, port: d.port ?? null }];
      break;
    }
    case 'task.reviewed':
      task.status = d.verdict === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      cur(task).review = { verdict: d.verdict, reviewer: d.reviewer, evidence: d.evidence, findings: d.findings };
      break;
    case 'task.integrated':
      task.status = 'INTEGRATED'; task.integration = { merge: d.merge, evidence: d.evidence, ts: ev.ts };
      break;
    case 'task.integration_failed':
      task.status = d.conflict ? 'NEEDS_REBASE' : 'INTEGRATION_FAILED';
      cur(task).integration = { ok: false, conflict: !!d.conflict, reason: d.reason, evidence: d.evidence, revert: d.revert || null };
      break;
    case 'task.blocked':
      task.status = 'BLOCKED'; task.blocker = d.report;
      s.blockers.push({ taskId: d.taskId, report: d.report, ts: ev.ts });
      break;
    case 'task.retry_granted':
      task.maxAttempts += d.extra || 1; task.status = d.resumeStatus || 'REJECTED';
      s.blockers = s.blockers.filter((b) => b.taskId !== d.taskId);
      break;
    case 'task.abandoned':
      task.status = 'ABANDONED';
      s.blockers = s.blockers.filter((b) => b.taskId !== d.taskId);
      break;
    case 'phase.checkpoint': {
      const p = phase(s, d.n); p.status = 'CHECKPOINT'; p.checkpoint = { evidence: d.evidence, report: d.report, ts: ev.ts };
      break;
    }
    case 'phase.approved': {
      const p = phase(s, d.n); p.status = 'APPROVED'; p.approvedAt = ev.ts;
      const next = s.phases.find((x) => x.status === 'PLANNED');
      if (next) { next.status = 'RUNNING'; next.startedAt = ev.ts; next.baseHead = d.nextBaseHead || null; s.currentPhase = next.n; }
      else { s.mode = 'RC_READY'; s.currentPhase = null; }
      break;
    }
    case 'phase.rejected': {
      const p = phase(s, d.n); p.status = 'RUNNING'; p.rejections = [...(p.rejections || []), { reason: d.reason, ts: ev.ts }];
      break;
    }
    case 'game.paused': s.paused = true; break;
    case 'game.resumed': s.paused = false; break;
    case 'decision.recorded': s.decisions.push({ ...d, ts: ev.ts }); break;
    case 'playtest.prepared': s.mode = 'PLAYTEST'; s.rc = { ...d, ts: ev.ts }; break;
    case 'playtest.approved': s.mode = 'PLAYTEST_APPROVED'; break;
    case 'playtest.rejected': s.mode = 'DEVELOPMENT'; reopenForFixes(s, d, ev.ts); break;
    case 'release.approved': s.mode = 'RELEASE_APPROVED'; s.release = { version: d.version, tag: d.tag, mainCommit: d.mainCommit, ts: ev.ts }; break;
    case 'release.packaged': s.mode = 'PACKAGED'; s.release = { ...s.release, package: d }; break;
    case 'publication.covers': s.publication.covers = { ...d, ts: ev.ts }; break;
    case 'publication.prepared': s.mode = 'PUBLICATION_PREPARED'; s.publication.prepared = true; s.publication.packet = d.packet; break;
    case 'publication.op': s.publication.ops.push({ ...d, ts: ev.ts }); break;
    // FX-15: `abandoned` is set only by this event, so replaying older logs yields byte-identical states.
    case 'game.abandoned': s.mode = 'ABANDONED'; s.abandoned = { reason: d.reason, fromMode: d.fromMode, ts: ev.ts }; break;
    case 'game.archived': s.mode = 'ARCHIVED'; s.archivedAt = ev.ts; s.archive = d; break;
    default:
      throw new Error(`Unknown event type ${ev.type}`);
  }
  return s;
}

function reopenForFixes(s, d, ts) {
  // A rejected playtest appends a corrective phase so history of approved phases stays intact.
  const n = Math.max(0, ...s.phases.map((p) => p.n)) + 1;
  s.phases.push({ n, name: d.phaseName || 'Playtest corrections', goal: d.reason, exitCriteria: d.exitCriteria || [], status: 'RUNNING', startedAt: ts });
  s.currentPhase = n;
}

function addTask(s, t) {
  if (s.tasks[t.id]) throw new Error(`Duplicate task id ${t.id}`);
  s.tasks[t.id] = { ...t, status: 'PENDING', attempts: [], maxAttempts: t.maxAttempts || 3, integration: null };
  s.taskOrder.push(t.id);
}

/** Apply a validated modification ({id, changes: {field: {before, after}}}) to a never-started PENDING task. */
function modifyTask(s, m, ev) {
  const t = s.tasks[m.id];
  // FactoryError (not Error): a task can start between `plan validate --amend` and the commit under the lock;
  // the CLI then prints a clean refusal with hints instead of INTERNAL ERROR (FX-06 review minor).
  const hints = ['Re-run: factory plan validate <file> --amend --game <id>', 'Started tasks cannot be modified: add a corrective task instead'];
  if (!t) throw new FactoryError(`plan.amended modifies unknown task ${m.id}`, hints);
  if (t.status !== 'PENDING' || t.attempts.length) {
    throw new FactoryError(`plan.amended cannot modify ${m.id}: it is ${t.status} with ${t.attempts.length} attempt(s)`, hints);
  }
  for (const [f, c] of Object.entries(m.changes || {})) t[f] = c.after;
  t.amendments = [...(t.amendments || []), { seq: ev.seq, ts: ev.ts, source: ev.data?.source ?? null, changes: m.changes }];
}

function cur(task) {
  return task.attempts[task.attempts.length - 1];
}

function phase(s, n) {
  const p = s.phases.find((x) => x.n === n);
  if (!p) throw new Error(`Unknown phase ${n}`);
  return p;
}

export function loadEvents(gameId) {
  return readJsonl(`${gameDir(gameId)}/events.jsonl`);
}

export function rebuild(gameId) {
  const events = loadEvents(gameId);
  if (!events.length) throw new FactoryError(`Game "${gameId}" has no events (not registered).`, ['factory game list']);
  let s = initialState(gameId);
  for (const ev of events) s = reduce(s, ev);
  return s;
}

export function gameExists(gameId) {
  return fs.existsSync(`${gameDir(gameId)}/events.jsonl`);
}

/** Load snapshot, rebuilding if missing or stale relative to the event log. */
export function loadState(gameId) {
  if (!gameExists(gameId)) throw new FactoryError(`Unknown game "${gameId}".`, ['factory game list']);
  const snap = readJson(`${gameDir(gameId)}/state.json`, null);
  const events = loadEvents(gameId);
  const last = events.length ? events[events.length - 1].seq : 0;
  if (snap && snap.lastSeq === last) return snap;
  const s = rebuild(gameId);
  writeJsonAtomic(`${gameDir(gameId)}/state.json`, s);
  return s;
}

/**
 * Append one or more events under the per-game lock, validating each against the
 * state it applies to. `guard(state)` may throw a FactoryError to refuse the change.
 */
export function commit(gameId, events, { actor = 'factory-cli', guard } = {}) {
  const dir = gameDir(gameId);
  fs.mkdirSync(dir, { recursive: true });
  const release = acquireLock(`${dir}/.lock`, { staleMs: loadConfig().lockStaleMs });
  try {
    let s = gameExists(gameId) ? rebuild(gameId) : initialState(gameId);
    if (guard) guard(s);
    let seq = s.lastSeq;
    const written = [];
    for (const e of events) {
      const ev = { seq: ++seq, ts: nowIso(), type: e.type, actor, data: e.data || {} };
      s = reduce(s, ev); // throws before anything is written if the event is malformed
      written.push(ev);
    }
    for (const ev of written) appendJsonl(`${dir}/events.jsonl`, ev);
    writeJsonAtomic(`${dir}/state.json`, s);
    return s;
  } finally {
    release();
  }
}

export function listGames() {
  const dir = paths().gamesState;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((g) => fs.existsSync(path.join(dir, g, 'events.jsonl'))).sort();
}

export function getFocus() {
  return readJson(paths().focus, { game: null }).game;
}

export function setFocus(gameId) {
  writeJsonAtomic(paths().focus, { game: gameId, ts: nowIso() });
}

/** Resolve game id: explicit arg, else focus. */
export function resolveGame(explicit) {
  const g = explicit || getFocus();
  if (!g) throw new FactoryError('No game selected.', ['factory game focus <id>', 'factory game list']);
  if (!gameExists(g)) throw new FactoryError(`Unknown game "${g}".`, ['factory game list']);
  return g;
}

/** Derived: tasks eligible to start now (deps integrated, phase running, not paused). */
export function readyTasks(s) {
  if (s.mode !== 'DEVELOPMENT' || s.paused) return [];
  const running = new Set(s.phases.filter((p) => p.status === 'RUNNING').map((p) => p.n));
  return s.taskOrder.map((id) => s.tasks[id]).filter((t) =>
    running.has(t.phase) &&
    (t.status === 'PENDING' || (TASK_RETRYABLE.has(t.status) && t.attempts.length < t.maxAttempts)) &&
    t.deps.every((d) => s.tasks[d]?.status === 'INTEGRATED'));
}

export function activeTasks(s) {
  return Object.values(s.tasks).filter((t) => ['IN_PROGRESS', 'SUBMITTED', 'VERIFIED', 'ACCEPTED'].includes(t.status));
}
