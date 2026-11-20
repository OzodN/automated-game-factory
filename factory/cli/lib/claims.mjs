// @ts-check
/**
 * Attempt-scoped claims (FX-02, defect FD-07).
 *
 * The agent map (`<state>/agents.json`) holds one entry per subagent id. `task claim` / `maint claim`
 * add `{ game, task, worktree, attempt, agentType, claimedAt }` to the entry. A TaskStop-killed subagent never
 * gets SubagentStop, so its entry may stay `active` forever; therefore a claim is only honoured while it is
 * LIVE:
 *   - `superseded`: its attempt is older than the task's current attempt (flagged by `task start` of the
 *     newer attempt, and also derived from state, so an unflagged old claim never blocks);
 *   - `released`:   the orchestrator ran `factory task release-claim` (agent stopped mid-attempt);
 *   - `closed`:     the task is no longer running (game task not IN_PROGRESS / maintenance item not STARTED);
 *   - `live`:       none of the above.
 * Superseded and released claims never block a new claim, never grant writes and never count towards the
 * Agent concurrency cap. `factory recover --apply` deactivates every active agent whose claim is not live.
 *
 * Writers of the agent map take `<state>/.agents.lock` (shared with the SubagentStart/Stop hook).
 */
import { paths, readJson, writeJsonAtomic, acquireLock, nowIso, FactoryError } from './core.mjs';
import { loadState, gameExists } from './state.mjs';
import { loadMaint, MAINT_GAME } from './maint.mjs';

/** Agents without a live claim are considered gone after this long (SubagentStop never arrived). */
export const AGENT_WINDOW_MS = 3 * 3600 * 1000;
/** Claim-entry fields that a fresh claim resets. */
const CLAIM_END_FIELDS = ['supersededBy', 'supersededAt', 'releasedAt', 'releasedBy', 'releaseReason', 'deactivatedAt', 'deactivatedBy'];

/** @returns {{agents: Record<string, any>}} */
export function readAgentMap() {
  const m = readJson(paths().agentMap, { agents: {} });
  m.agents ||= {};
  return m;
}

/**
 * Read-modify-write the agent map under the agents lock.
 * @template R
 * @param {(m: {agents: Record<string, any>}) => R} fn
 * @returns {R}
 */
export function updateAgentMap(fn) {
  const p = paths();
  const release = acquireLock(`${p.state}/.agents.lock`, { staleMs: 10000, timeoutMs: 8000 });
  try {
    const m = readAgentMap();
    const r = fn(m);
    writeJsonAtomic(p.agentMap, m);
    return r;
  } finally {
    release();
  }
}

/**
 * Register (or re-register) a claim for `agentId`. A fresh claim makes the entry active again and clears any
 * superseded/released marks of an earlier claim by the same agent id.
 * @param {string} agentId @param {Record<string, any>} rec
 */
export function recordClaim(agentId, rec) {
  updateAgentMap((m) => {
    const prev = m.agents[agentId] || { startedAt: nowIso() };
    const next = { ...prev, ...rec, active: true };
    for (const k of CLAIM_END_FIELDS) delete next[k];
    m.agents[agentId] = next;
  });
}

/**
 * The claimed task's current attempt and whether it is still running, or null when the task is unknown.
 * Factory maintenance items have a single attempt unless the item records `attempt`.
 * @param {string} game @param {string} task
 * @returns {{attempt: number, open: boolean} | null}
 */
export function claimTarget(game, task) {
  try {
    if (game === MAINT_GAME) {
      const it = loadMaint()[task];
      return it ? { attempt: it.attempt ?? 1, open: it.status === 'STARTED' } : null;
    }
    if (!game || !gameExists(game)) return null;
    const t = loadState(game).tasks[task];
    return t ? { attempt: t.attempts.length, open: t.status === 'IN_PROGRESS' } : null;
  } catch {
    return null;
  }
}

/**
 * State of an agent-map entry's claim.
 * @param {any} a agent-map entry
 * @param {{attempt: number, open: boolean} | null} [target] defaults to claimTarget(a.game, a.task)
 * @returns {{state: 'unclaimed'|'live'|'superseded'|'released'|'closed'|'unknown', by?: number, reason?: string}}
 */
export function claimState(a, target) {
  if (!a?.task) return { state: 'unclaimed' };
  if (a.releasedAt) return { state: 'released', reason: `claim released by the orchestrator${a.releaseReason ? ` (${a.releaseReason})` : ''}` };
  const t = target === undefined ? claimTarget(a.game, a.task) : target;
  const cur = t?.attempt ?? 0;
  const mine = a.attempt ?? cur;
  const by = Math.max(a.supersededBy ?? 0, mine < cur ? cur : 0);
  if (by) return { state: 'superseded', by, reason: `superseded by attempt ${by}` };
  if (!t) return { state: 'unknown', reason: `${a.game}/${a.task} is unknown` };
  if (!t.open) return { state: 'closed', reason: `${a.task} is no longer in progress` };
  return { state: 'live' };
}

/** True when the claim was superseded or released: the agent must not write or block anything any more. */
export const claimEnded = (st) => st.state === 'superseded' || st.state === 'released';

/** Memoized claimTarget for scans over the whole map. */
function targetCache() {
  const cache = new Map();
  return (a) => {
    const k = `${a.game}\u0000${a.task}`;
    if (!cache.has(k)) cache.set(k, claimTarget(a.game, a.task));
    return cache.get(k);
  };
}

/**
 * Agents that count towards the concurrency cap and `status`: active, started within AGENT_WINDOW_MS, and
 * not holding a superseded or released claim.
 * @returns {Array<[string, any]>}
 */
export function liveAgents(map = readAgentMap(), now = Date.now()) {
  const target = targetCache();
  return Object.entries(map.agents || {}).filter(([, a]) => a.active &&
    now - Date.parse(a.startedAt || a.claimedAt || a.ts) < AGENT_WINDOW_MS &&
    (!a.task || !claimEnded(claimState(a, target(a)))));
}

/**
 * The live holder (other than `exceptId`) of a claim on `game/task` for the task's current attempt.
 * Superseded and released claims never block.
 */
export function liveHolder(game, task, exceptId) {
  const t = claimTarget(game, task);
  const hit = Object.entries(readAgentMap().agents).find(([id, a]) => id !== exceptId && a.active && a.game === game && a.task === task &&
    !claimEnded(claimState(a, t)));
  return hit ? hit[0] : null;
}

/**
 * `task start` of attempt N: mark every claim of the task with attempt < N as superseded and deactivate
 * its agent (a killed agent never gets SubagentStop).
 * @returns {string[]} ids of agents that were active and are now deactivated
 */
export function supersedeClaims(game, task, attempt) {
  return updateAgentMap((m) => {
    const out = [];
    for (const [id, a] of Object.entries(m.agents)) {
      if (a.game !== game || a.task !== task || a.releasedAt || (a.attempt ?? 0) >= attempt) continue;
      if (a.active) out.push(id);
      a.supersededBy = Math.max(a.supersededBy ?? 0, attempt);
      a.supersededAt = nowIso();
      a.active = false;
    }
    return out;
  });
}

/**
 * Release the current claim of a task (the agent stopped mid-attempt; the same attempt is re-dispatched to a
 * fresh agent). Without `agentId` every active claim of the current attempt is released.
 * @param {string} game @param {string} task @param {{agentId?: string, reason?: string, by?: string}} [opts]
 * @returns {Array<{agentId: string, agentType: string, attempt: number}>}
 */
export function releaseClaims(game, task, { agentId, reason, by = 'orchestrator' } = {}) {
  const t = claimTarget(game, task);
  if (!t) throw new FactoryError(`Unknown task ${task} in ${game}.`);
  return updateAgentMap((m) => {
    let hits;
    if (agentId) {
      const a = m.agents[agentId];
      if (!a || a.game !== game || a.task !== task) throw new FactoryError(`Agent ${agentId} holds no claim of ${task} in ${game}.`, [`factory task release-claim ${task} --game ${game} (releases the current claim)`]);
      if (a.releasedAt) throw new FactoryError(`The claim of ${task} by ${agentId} was already released at ${a.releasedAt}.`);
      hits = [[agentId, a]];
    } else {
      hits = Object.entries(m.agents).filter(([, a]) => a.active && a.game === game && a.task === task && !claimEnded(claimState(a, t)));
      if (!hits.length) throw new FactoryError(`${task} has no active claim to release.`, ['factory recover (lists stale claims)', `factory task release-claim ${task} --game ${game} --agent <agentId>`]);
    }
    const ts = nowIso();
    return hits.map(([id, a]) => {
      Object.assign(a, { active: false, releasedAt: ts, releasedBy: by, releaseReason: reason || null });
      return { agentId: id, agentType: a.agentType, attempt: a.attempt ?? t.attempt };
    });
  });
}

/**
 * Active agents whose claim is superseded, released, closed (task no longer in progress) or unknown.
 * `recover --apply` deactivates them regardless of age.
 * @returns {Array<{id: string, a: any, state: string, reason: string}>}
 */
export function staleClaims(map = readAgentMap()) {
  const target = targetCache();
  const out = [];
  for (const [id, a] of Object.entries(map.agents || {})) {
    if (!a.active || !a.task) continue;
    const st = claimState(a, target(a));
    if (st.state !== 'live') out.push({ id, a, state: st.state, reason: st.reason || st.state });
  }
  return out;
}

/** Deactivate the given agent ids (recovery). */
export function deactivateAgents(ids, by = 'recover') {
  if (!ids.length) return;
  updateAgentMap((m) => {
    const ts = nowIso();
    for (const id of ids) if (m.agents[id]?.active) Object.assign(m.agents[id], { active: false, deactivatedAt: ts, deactivatedBy: by });
  });
}
