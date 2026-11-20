// @ts-check
/**
 * Development plan validation: phases, task DAG, agent/reviewer independence,
 * measurable acceptance criteria, and scope isolation between tasks that may run in parallel.
 */
import { TASK_ID_RE, globsMayOverlap, FactoryError, loadConfig } from './core.mjs';
import { FACTORY_AGENTS, RETRY_SUFFIX, sameBaseRole } from './agents.mjs';

/** Derived from the agent roster (base roles only: a plan never names a `-retry` variant). */
export const IMPLEMENTERS = [...FACTORY_AGENTS.implementers];
export const REVIEWERS = [...FACTORY_AGENTS.reviewers];
/** Default of config `planTestTreeMaxCriteria` (L-01): a task owning a whole test tree with more criteria is flagged. */
export const TEST_TREE_MAX_CRITERIA = 25;
/** Fields a `modify` entry of a plan amendment may change (PENDING, never-started tasks only). */
export const MODIFIABLE_FIELDS = ['title', 'description', 'acceptance', 'inputs', 'outputs', 'tests', 'risk', 'deps', 'scope', 'agent', 'reviewer'];
export const RISKS = ['low', 'medium', 'high'];
const VAGUE = /\b(perfect(ly)?|excellent|flawless(ly)?|seamless(ly)?|bug[- ]free|great|nice|good enough|as needed|properly|appropriate(ly)?|user[- ]friendly|intuitive)\b/i;
/** Paths no task may touch unless it carries the matching explicit flag. */
export const PROTECTED_SCOPES = [
  { glob: 'design/spec/**', flag: null, why: 'the specification is frozen' },
  { glob: 'design/concept/**', flag: null, why: 'the concept is frozen' },
  { glob: 'vendor/**', flag: 'allowVendor', why: 'shared kit upgrades need an explicit kit-upgrade task' },
];

/**
 * @param {any} plan
 * @param {{existingTasks?: Record<string, any>, existingPhases?: any[], testTreeMaxCriteria?: number, errors?: string[]}} [ctx]
 *   `errors`: problems the caller already found (e.g. in an amendment's modify list), reported together.
 * @returns {{phases:any[], tasks:any[], warnings:string[]}}
 */
export function validatePlan(plan, ctx = {}) {
  const errors = [...(ctx.errors || [])];
  const warnings = [];
  const existing = ctx.existingTasks || {};
  const maxCriteria = ctx.testTreeMaxCriteria ?? loadConfig().planTestTreeMaxCriteria ?? TEST_TREE_MAX_CRITERIA;
  const phases = plan.phases ?? ctx.existingPhases ?? [];
  if (!Array.isArray(phases) || !phases.length) errors.push('plan.phases must be a non-empty array');
  const phaseNums = new Set();
  for (const p of phases) {
    if (!Number.isInteger(p.n) || p.n < 1) errors.push(`phase.n must be a positive integer (got ${p.n})`);
    if (phaseNums.has(p.n)) errors.push(`duplicate phase ${p.n}`);
    phaseNums.add(p.n);
    if (!p.name) errors.push(`phase ${p.n}: name required`);
    if (!Array.isArray(p.exitCriteria) || !p.exitCriteria.length) errors.push(`phase ${p.n}: exitCriteria must be a non-empty array`);
    for (const c of p.exitCriteria || []) if (VAGUE.test(c)) errors.push(`phase ${p.n}: exit criterion is not measurable: "${c}"`);
  }
  if (!ctx.existingPhases && phases.length > 8) warnings.push(`${phases.length} phases is unusually many; prefer 4-6`);

  const tasks = plan.tasks;
  if (!Array.isArray(tasks) || !tasks.length) errors.push('plan.tasks must be a non-empty array');
  const ids = new Set(Object.keys(existing));
  const all = { ...existing };
  for (const t of tasks || []) {
    const where = `task ${t.id ?? '?'}`;
    if (!TASK_ID_RE.test(t.id || '')) errors.push(`${where}: id must match ${TASK_ID_RE}`);
    if (ids.has(t.id)) errors.push(`${where}: duplicate id`);
    ids.add(t.id);
    all[t.id] = t;
    if (!phaseNums.has(t.phase)) errors.push(`${where}: unknown phase ${t.phase}`);
    if (!t.title) errors.push(`${where}: title required`);
    if (!t.description || t.description.length < 30) errors.push(`${where}: description must be specific (>= 30 chars)`);
    if (!IMPLEMENTERS.includes(t.agent)) errors.push(`${where}: agent must be one of ${IMPLEMENTERS.join(', ')}${retryHint(t.agent)}`);
    if (!REVIEWERS.includes(t.reviewer)) errors.push(`${where}: reviewer must be one of ${REVIEWERS.join(', ')}${retryHint(t.reviewer)}`);
    if (typeof t.agent === 'string' && typeof t.reviewer === 'string' && sameBaseRole(t.agent, t.reviewer)) {
      errors.push(`${where}: reviewer must differ from implementer (independent verification; same base role: ${t.agent} / ${t.reviewer})`);
    }
    if (!Array.isArray(t.deps)) errors.push(`${where}: deps must be an array`);
    if (!Array.isArray(t.scope) || !t.scope.length) errors.push(`${where}: scope globs required (files the task may change)`);
    for (const g of t.scope || []) {
      for (const ps of PROTECTED_SCOPES) {
        if (globsMayOverlap(g, ps.glob) && !(ps.flag && t[ps.flag])) errors.push(`${where}: scope "${g}" touches ${ps.glob} (${ps.why})`);
      }
      if (g.startsWith('/') || g.includes('..')) errors.push(`${where}: scope "${g}" must be repo-relative`);
    }
    if (!Array.isArray(t.acceptance) || !t.acceptance.length) errors.push(`${where}: acceptance criteria required`);
    const acIds = new Set();
    for (const ac of t.acceptance || []) {
      if (!ac.id || acIds.has(ac.id)) errors.push(`${where}: each acceptance criterion needs a unique id`);
      acIds.add(ac.id);
      if (!ac.text) errors.push(`${where}/${ac.id}: text required`);
      else if (VAGUE.test(ac.text)) errors.push(`${where}/${ac.id}: not measurable ("${ac.text}")`);
      if (!['test', 'command', 'review', 'manual'].includes(ac.check)) errors.push(`${where}/${ac.id}: check must be test|command|review|manual`);
      if ((ac.check === 'test' || ac.check === 'command') && !ac.ref) errors.push(`${where}/${ac.id}: ${ac.check} criteria need "ref" (test file/name or command)`);
    }
    if (!Array.isArray(t.tests)) errors.push(`${where}: tests (test requirements) must be an array`);
    if (!RISKS.includes(t.risk)) errors.push(`${where}: risk must be low|medium|high`);
    const tree = Array.isArray(t.scope) ? t.scope.find(isWholeTestTree) : undefined;
    const nAc = Array.isArray(t.acceptance) ? t.acceptance.length : 0;
    if (tree && nAc > maxCriteria) {
      warnings.push(`L-01: ${where} owns the whole test tree "${tree}" with ${nAc} acceptance criteria (> ${maxCriteria}); consider splitting it by area (flows / viewports / quality)`);
    }
  }
  for (const t of tasks || []) {
    for (const d of t.deps || []) {
      if (!all[d]) errors.push(`task ${t.id}: unknown dependency ${d}`);
      else if (all[d].phase > t.phase) errors.push(`task ${t.id}: depends on later-phase task ${d}`);
    }
  }
  if (!errors.length) {
    const cycle = findCycle(all);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  if (!errors.length) {
    // Tasks that can run concurrently (same phase, no dependency path) must not share files.
    const list = Object.values(all);
    const reach = reachability(all);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]; const b = list[j];
        if (a.phase !== b.phase) continue;
        if (reach[a.id].has(b.id) || reach[b.id].has(a.id)) continue;
        for (const ga of a.scope) for (const gb of b.scope) {
          if (globsMayOverlap(ga, gb)) errors.push(`parallel tasks ${a.id} and ${b.id} have overlapping scopes "${ga}" / "${gb}"; add a dependency or split scopes`);
        }
      }
    }
  }
  if (errors.length) throw new FactoryError(`Plan invalid (${errors.length} problems):\n - ${errors.join('\n - ')}`);
  const maxAttempts = loadConfig().maxAttempts;
  const normTasks = tasks.map((t) => ({
    id: t.id, phase: t.phase, title: t.title, description: t.description, agent: t.agent, reviewer: t.reviewer,
    deps: t.deps, inputs: t.inputs || [], outputs: t.outputs || [], scope: t.scope, acceptance: t.acceptance,
    tests: t.tests, risk: t.risk, allowDeps: !!t.allowDeps, allowVendor: !!t.allowVendor,
    verifySteps: t.verifySteps || null, maxAttempts: t.maxAttempts || maxAttempts,
  }));
  const normPhases = (plan.phases || []).map((p) => ({ n: p.n, name: p.name, goal: p.goal || '', exitCriteria: p.exitCriteria }));
  return { phases: normPhases, tasks: normTasks, warnings };
}

const retryHint = (v) => (typeof v === 'string' && v.endsWith(RETRY_SUFFIX) ? ` (a plan names base agents only, never ${RETRY_SUFFIX} variants)` : '');

/** A scope glob that covers an entire e2e/test tree, e.g. `tests/**`, `tests/e2e/**`, `e2e/**`. */
export function isWholeTestTree(glob) {
  if (typeof glob !== 'string' || !glob.endsWith('/**')) return false;
  const segs = glob.slice(0, -3).split('/');
  return segs.every((x) => x && !/[*?{[]/.test(x)) && /^(tests?|e2e|__tests__)$/i.test(segs[segs.length - 1]);
}

/** Values a task has when a field was omitted at load time (validatePlan normalization). */
const FIELD_DEFAULTS = { inputs: [], outputs: [] };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validate a plan amendment against the current game state. Pure: writes nothing.
 * Format: `{ tasks?: Task[], modify?: Array<{ id, <field>? }> }`; other top-level keys (`game`, `source`, `notes`)
 * are documentation and ignored. New tasks are validated like plan tasks. A modified task is validated as a whole
 * AFTER the change, together with the new tasks, against all other tasks (scope overlap with parallel tasks,
 * reviewer base role != agent base role, deps, cycles). Only PENDING tasks that were never started may be modified.
 * @param {any} amend
 * @param {any} s current game state
 * @param {{testTreeMaxCriteria?: number}} [opts]
 * @returns {{tasks:any[], modified:Array<{id:string, changes:Record<string,{before:any, after:any}>}>, warnings:string[]}}
 */
export function validateAmendment(amend, s, opts = {}) {
  if (!amend || typeof amend !== 'object' || Array.isArray(amend)) throw new FactoryError('Plan amendment must be a JSON object { "tasks"?: [...], "modify"?: [...] }.');
  const errors = [];
  const warnings = [];
  if (amend.phases !== undefined) errors.push('an amendment cannot change phases (remove "phases"; new tasks go into existing phases)');
  const newTasks = Array.isArray(amend.tasks) ? amend.tasks : [];
  const modify = Array.isArray(amend.modify) ? amend.modify : [];
  if (amend.tasks !== undefined && !Array.isArray(amend.tasks)) errors.push('amendment "tasks" must be an array');
  if (amend.modify !== undefined && !Array.isArray(amend.modify)) errors.push('amendment "modify" must be an array');
  const phases = s.phases || [];
  const merged = [];
  const seen = new Set();
  for (const m of modify) {
    const id = m && typeof m === 'object' ? m.id : undefined;
    const where = `modify ${id ?? '?'}`;
    if (typeof id !== 'string') { errors.push(`${where}: each modify entry needs an "id"`); continue; }
    if (seen.has(id)) { errors.push(`${where}: listed twice`); continue; }
    seen.add(id);
    const t = s.tasks?.[id];
    if (!t) { errors.push(`${where}: unknown task (new tasks go into "tasks", not "modify")`); continue; }
    const attempts = (t.attempts || []).length;
    if (t.status !== 'PENDING' || attempts) {
      errors.push(`${where}: task is ${t.status}${attempts ? ` with ${attempts} attempt(s)` : ''}; only PENDING tasks that were never started can be modified. Add a corrective task in "tasks" instead.`);
      continue;
    }
    const p = phases.find((x) => x.n === t.phase);
    if (p?.status === 'APPROVED') { errors.push(`${where}: phase ${p.n} is approved`); continue; }
    const bad = Object.keys(m).filter((k) => k !== 'id' && !MODIFIABLE_FIELDS.includes(k));
    if (bad.length) errors.push(`${where}: field(s) ${bad.join(', ')} cannot be modified (allowed: ${MODIFIABLE_FIELDS.join(', ')})`);
    const fields = MODIFIABLE_FIELDS.filter((f) => m[f] !== undefined);
    if (!fields.length) errors.push(`${where}: no field to change`);
    const after = { ...t };
    for (const f of fields) after[f] = m[f];
    merged.push({ id, before: t, after, fields });
  }
  for (const t of newTasks) {
    const p = phases.find((x) => x.n === t?.phase);
    if (p?.status === 'APPROVED') errors.push(`task ${t.id}: cannot be added to approved phase ${p.n}`);
  }
  const toValidate = [...merged.map((x) => x.after), ...newTasks];
  if (!toValidate.length && !errors.length) errors.push('amendment has neither new "tasks" nor "modify" entries');
  if (!toValidate.length) throw new FactoryError(`Plan amendment invalid (${errors.length} problems):\n - ${errors.join('\n - ')}`);
  const existingTasks = Object.fromEntries(Object.entries(s.tasks || {}).filter(([id]) => !seen.has(id)));
  let r;
  try {
    r = validatePlan({ tasks: toValidate }, { existingTasks, existingPhases: phases, testTreeMaxCriteria: opts.testTreeMaxCriteria, errors });
  } catch (e) {
    if (e instanceof FactoryError) throw new FactoryError(e.message.replace(/^Plan invalid/, 'Plan amendment invalid'));
    throw e;
  }
  warnings.push(...r.warnings);
  const norm = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  const modified = [];
  for (const x of merged) {
    /** @type {Record<string, {before:any, after:any}>} */
    const changes = {};
    for (const f of x.fields) {
      const before = x.before[f] === undefined ? (FIELD_DEFAULTS[f] ?? null) : x.before[f];
      const after = norm[x.id][f];
      if (!same(before, after)) changes[f] = { before, after };
    }
    if (Object.keys(changes).length) modified.push({ id: x.id, changes });
    else warnings.push(`modify ${x.id}: the listed values equal the current ones; nothing changes`);
  }
  return { tasks: r.tasks.filter((t) => !seen.has(t.id)), modified, warnings };
}

/** One line per changed field (values JSON, shortened), for CLI output and phase reports. */
export function describeModification(m, width = 160) {
  const short = (v) => { const j = JSON.stringify(v); return j.length > width ? `${j.slice(0, width - 3)}...` : j; };
  return Object.entries(m.changes).map(([f, c]) => `${m.id}.${f}: ${short(c.before)} -> ${short(c.after)}`);
}

function findCycle(all) {
  const state = {};
  const stack = [];
  const visit = (id) => {
    if (state[id] === 2) return null;
    if (state[id] === 1) return [...stack.slice(stack.indexOf(id)), id];
    state[id] = 1; stack.push(id);
    for (const d of all[id].deps || []) { const c = visit(d); if (c) return c; }
    stack.pop(); state[id] = 2;
    return null;
  };
  for (const id of Object.keys(all)) { const c = visit(id); if (c) return c; }
  return null;
}

/** reach[a] = set of all transitive dependencies of a. */
function reachability(all) {
  const memo = {};
  const go = (id) => {
    if (memo[id]) return memo[id];
    const s = new Set();
    memo[id] = s;
    for (const d of all[id].deps || []) { s.add(d); for (const x of go(d)) s.add(x); }
    return s;
  };
  for (const id of Object.keys(all)) go(id);
  return memo;
}
