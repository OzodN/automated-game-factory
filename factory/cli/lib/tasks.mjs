// @ts-check
/**
 * Task lifecycle: start (isolated worktree) -> submit (report ingest) -> verify (deterministic checks)
 * -> review (independent reviewer verdict) -> integrate (no-ff merge + regression, auto-revert on failure).
 * Every judgment is made from evidence the CLI produces itself; agent self-reports are informational.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  paths, git, run, readJson, readJsonl, writeJsonAtomic, writeTextAtomic, ensureDir, matchesAny,
  FactoryError, loadConfig, samePathPrefix, norm, acquireLock, nowIso,
} from './core.mjs';
import { loadState, commit, readyTasks, gameDir, TASK_RETRYABLE } from './state.mjs';
import { PROTECTED_SCOPES } from './plan.mjs';
import { dispatchAgent, pinFor, sameBaseRole } from './agents.mjs';
import { reservePort, acquireVerifyMarker, assertNoLiveVerify, classifyFailure, infraRetryLimit } from './runs.mjs';
import { validateReview, reviewConsequences, formatFinding, renderReviewSchema } from './review-schema.mjs';
import { supersedeClaims, releaseClaims } from './claims.mjs';
import { scanExternalUrls } from './url-scan.mjs';

export const gameRepo = (g) => `${paths().games}/${g}`;
export const wtDir = (g, id) => `${paths().worktrees}/${g}/${id}`;
export const integrationDir = (g) => `${paths().worktrees}/${g}/_integration`;
export const inboxDir = (g, id) => `${paths().inbox}/${g}/${id}`;
export const evidenceDir = (g, id, n) => `${gameDir(g)}/evidence/${id}/a${n}`;
export const taskBranch = (id) => `task/${id}`;

export function gameConfig(dir) {
  const f = `${dir}/factory.game.json`;
  if (!fs.existsSync(f)) throw new FactoryError(`Missing ${f}; the game was not scaffolded from a factory template.`);
  return readJson(f);
}

/** Make sure the dedicated integration worktree on `develop` exists and is clean. */
export function ensureIntegrationWorktree(g) {
  const dir = integrationDir(g);
  if (!fs.existsSync(dir)) {
    ensureDir(path.dirname(dir));
    git(['worktree', 'add', dir, 'develop'], gameRepo(g));
  }
  if (fs.existsSync(`${dir}/.git`) && fs.existsSync(gitPath(dir, 'MERGE_HEAD'))) {
    git(['merge', '--abort'], dir, { allowFail: true });
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], dir);
  if (dirty) throw new FactoryError(`Integration worktree ${dir} has uncommitted changes; refusing to integrate.`, ['factory recover']);
  return dir;
}

function gitPath(wt, name) {
  const p = git(['rev-parse', '--git-path', name], wt);
  return path.isAbsolute(p) ? p : path.join(wt, p);
}

// ---------------------------------------------------------------- start

export const PINNED_MODELS_MSG = 'Models are pinned in .claude/agents/*.md (table: factory/config.json "models"); `task start` takes no model or effort. ' +
  'Attempt 1 runs as the task agent, attempts >= 2 as its "-retry" variant (see "Dispatch to").';

/**
 * Start the next attempt of a task. The attempt's agent (the "Dispatch to" agent) is the base agent on
 * attempt 1 and `<agent>-retry` on attempts >= 2 when that variant exists; its pinned model is recorded.
 * @param {string} g @param {string} taskId @param {{model?: any, effort?: any}} [opts] model/effort are refused
 */
export function startTask(g, taskId, opts = {}) {
  if ((opts.model ?? null) !== null || (opts.effort ?? null) !== null) throw new FactoryError(PINNED_MODELS_MSG);
  const cfg = loadConfig();
  let attempt = 0;
  let wt = '';
  const s0 = loadState(g);
  const t0 = s0.tasks[taskId];
  if (!t0) throw new FactoryError(`Unknown task ${taskId}`);
  const s = commit(g, [], {
    guard: (s) => {
      const t = s.tasks[taskId];
      if (s.mode !== 'DEVELOPMENT') throw new FactoryError(`Game is in ${s.mode}; tasks run only in DEVELOPMENT.`);
      if (s.paused) throw new FactoryError('Game is paused.', ['User types /resume']);
      if (t.status === 'BLOCKED') throw new FactoryError(`${taskId} is BLOCKED; a human decision is required.`, [`User types /retry-task ${taskId} or /abandon-task ${taskId}`]);
      if (TASK_RETRYABLE.has(t.status) && t.attempts.length >= t.maxAttempts) throw new FactoryError(`${taskId} exhausted ${t.maxAttempts} attempts.`);
      if (!readyTasks(s).some((r) => r.id === taskId)) {
        const waiting = t.deps.filter((d) => s.tasks[d]?.status !== 'INTEGRATED');
        throw new FactoryError(`${taskId} is not ready (status ${t.status}${waiting.length ? `, waiting on ${waiting.join(', ')}` : ''}).`);
      }
      const inProgress = Object.values(s.tasks).filter((x) => x.status === 'IN_PROGRESS').length;
      if (inProgress >= cfg.concurrency) throw new FactoryError(`Concurrency cap ${cfg.concurrency} reached (${inProgress} in progress).`, ['Wait for a running task to be submitted']);
    },
  });
  const t = s.tasks[taskId];
  attempt = t.attempts.length + 1;
  const agent = dispatchAgent(t.agent, attempt, cfg);
  const pin = pinFor(agent, cfg) || { model: null, effort: null };
  wt = wtDir(g, taskId);
  const repo = gameRepo(g);
  const developHead = git(['rev-parse', 'develop'], repo);
  if (!fs.existsSync(wt)) {
    ensureDir(path.dirname(wt));
    const exists = git(['rev-parse', '--verify', '--quiet', taskBranch(taskId)], repo, { allowFail: true }).code === 0;
    git(exists ? ['worktree', 'add', wt, taskBranch(taskId)] : ['worktree', 'add', '-b', taskBranch(taskId), wt, 'develop'], repo);
  }
  const prev = t.attempts[t.attempts.length - 1] || null;
  const packet = renderPacket(g, s, t, attempt, wt, prev, { agent, ...pin });
  ensureDir(inboxDir(g, taskId));
  writeTextAtomic(`${inboxDir(g, taskId)}/packet-a${attempt}.md`, packet);
  commit(g, [{ type: 'task.started', data: { taskId, attempt, worktree: wt, branch: taskBranch(taskId), base: developHead, agent, baseAgent: t.agent, model: pin.model, effort: pin.effort } }], { actor: 'orchestrator' });
  // Claims of older attempts are superseded: their agents (possibly killed without SubagentStop) are deactivated,
  // lose write access and never block the claim of this attempt.
  const superseded = supersedeClaims(g, taskId, attempt);
  return {
    taskId, attempt, dispatchTo: agent, model: pin.model, effort: pin.effort, baseAgent: t.agent,
    worktree: wt, branch: taskBranch(taskId), packet: `${inboxDir(g, taskId)}/packet-a${attempt}.md`, supersededAgents: superseded,
  };
}

/**
 * `factory task release-claim <id> [--agent <agentId>] [--reason "..."]` (orchestrator only): the agent of the
 * current attempt stopped mid-attempt (e.g. TaskStop, no SubagentStop). Its claim is released and the agent
 * marked inactive, so the SAME attempt can be re-dispatched to a fresh agent of the same type.
 * @param {string} g @param {string} taskId @param {{agentId?: string, reason?: string}} [opts]
 */
export function releaseTaskClaim(g, taskId, opts = {}) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!t) throw new FactoryError(`Unknown task ${taskId}`);
  const released = releaseClaims(g, taskId, { agentId: opts.agentId, reason: opts.reason, by: 'orchestrator' });
  commit(g, released.map((r) => ({ type: 'task.claim_released', data: { taskId, attempt: r.attempt, agentId: r.agentId, agentType: r.agentType, by: 'orchestrator', reason: opts.reason || null } })), { actor: 'orchestrator' });
  const n = t.attempts.length;
  return {
    taskId, released, status: t.status, attempt: n,
    next: t.status === 'IN_PROGRESS' ? `re-dispatch ${t.attempts[n - 1]?.agent || t.agent} for attempt ${n} on the same worktree (packet ${inboxDir(g, taskId)}/packet-a${n}.md)` : `task is ${t.status}; no re-dispatch needed`,
  };
}

/** One-line dispatch instruction for the orchestrator (packet, `task start` output). */
export function dispatchLine(agent, model, effort) {
  return `Dispatch to: ${agent} (subagent_type "${agent}"; pinned model ${model || '(unpinned)'}, effort ${effort || '(default)'}; never pass model or effort on the Agent call)`;
}

function renderPacket(g, s, t, attempt, wt, prev, run) {
  const ib = inboxDir(g, t.id);
  const lines = [
    `# Task packet ${t.id} (attempt ${attempt}/${t.maxAttempts})`,
    '',
    `- ${dispatchLine(run.agent, run.model, run.effort)}`,
    `- Game: ${g} — ${s.title}`,
    `- Phase: ${t.phase}`,
    `- Task agent (base role): ${t.agent}; this attempt runs as: ${run.agent}; independent reviewer: ${t.reviewer}`,
    `- Risk: ${t.risk}`,
    `- Worktree (your ONLY writable code location): \`${wt}\``,
    `- Branch: \`${taskBranch(t.id)}\` (based on develop)`,
    `- Report file you must write with the Write tool: \`${ib}/report-a${attempt}.json\``,
    '',
    '## First action',
    `Run: \`node "${paths().root}/factory/cli/factory.mjs" task claim ${t.id} --game ${g}\` (registers you for this worktree; writes elsewhere are denied; only ${run.agent} may claim attempt ${attempt}).`,
    '',
    `## Title\n${t.title}`,
    '',
    `## Description\n${t.description}`,
    '',
    '## Inputs (read these; paths are relative to the worktree)',
    ...(t.inputs.length ? t.inputs.map((i) => `- ${i}`) : ['- design/spec/ (frozen specification)']),
    '',
    '## Expected outputs',
    ...(t.outputs.length ? t.outputs.map((o) => `- ${o}`) : ['- see description']),
    '',
    '## Allowed scope (you may ONLY change files matching these globs)',
    ...t.scope.map((x) => `- \`${x}\``),
    t.allowDeps ? '- package.json / pnpm-lock.yaml (dependency changes allowed for this task)' : '- NOT allowed: package.json, pnpm-lock.yaml, vendor/**, design/**',
    '',
    '## Acceptance criteria (each is checked independently)',
    ...t.acceptance.map((a) => `- **${a.id}** [${a.check}${a.ref ? `: ${a.ref}` : ''}] ${a.text}`),
    '',
    '## Test requirements',
    ...(t.tests.length ? t.tests.map((x) => `- ${x}`) : ['- none beyond the standard verify suite']),
    '',
  ];
  if (prev) {
    lines.push('## Feedback from the previous attempt (address every item)');
    if (prev.verify && !prev.verify.ok) lines.push(`- Verification FAILED: ${prev.verify.summary}`, `  Evidence: ${prev.verify.evidence}`);
    if (prev.review && prev.review.verdict !== 'ACCEPT') {
      lines.push(`- Review REJECTED by ${prev.review.reviewer}:`);
      const fs0 = Array.isArray(prev.review.findings) ? prev.review.findings : [];
      for (const f of fs0) lines.push(`  - ${formatFinding(f)}`);
      if (!fs0.length) lines.push(`  - (no findings listed; read ${prev.review.evidence || 'the review evidence'})`);
    }
    if (prev.integration && !prev.integration.ok) {
      lines.push(prev.integration.conflict
        ? '- Integration CONFLICT with develop. Run `git merge develop` in your worktree and resolve each conflict deliberately (understand both sides; never pick a side wholesale). Re-run tests.'
        : `- Post-merge regression FAILED and the merge was reverted: ${prev.integration.reason}. Evidence: ${prev.integration.evidence}. Merge develop into your branch, reproduce, fix.`);
    }
    lines.push('');
  }
  lines.push(
    '## Definition of Done',
    '1. All work committed on your branch in the worktree (no uncommitted changes). Conventional commit messages: `<type>(<task-id>): <summary>`.',
    '2. Only files inside the allowed scope changed.',
    '3. `corepack pnpm run verify` passes inside the worktree (typecheck, lint, unit, build, release check).',
    '4. Every acceptance criterion is satisfied and covered by a test where its check type is `test`.',
    `5. Report written with the Write tool to \`${ib}/report-a${attempt}.json\`:`,
    '```json',
    JSON.stringify({
      taskId: t.id, attempt, agent: run.agent, summary: 'what you implemented and why',
      filesChanged: ['src/...'], testsRun: [{ name: 'unit', command: 'corepack pnpm test:unit', result: 'pass' }],
      acceptance: t.acceptance.map((a) => ({ id: a.id, status: 'met', evidence: 'test name / file:line' })),
      knownLimitations: [], unresolvedDefects: [], notes: '',
    }, null, 2),
    '```',
    '',
    'The factory re-runs all checks itself; your report never substitutes for evidence. Do not edit anything outside the worktree and the report file.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------- provenance

/** Who last wrote `file` through Write/Edit tools (recorded by the PreToolUse hook)? */
export function lastWriter(file) {
  const target = norm(file).toLowerCase();
  const recs = readJsonl(paths().provenance);
  for (let i = recs.length - 1; i >= 0; i--) if (recs[i].path === target) return recs[i];
  return null;
}

/** Throw unless `file` was last written through a tracked tool by `expectedAgent` and not altered since. */
export function assertProvenance(file, expectedAgents) {
  if (!fs.existsSync(file)) throw new FactoryError(`Expected file missing: ${file}`);
  const w = lastWriter(file);
  if (!w) throw new FactoryError(`${file} was not written through a tracked Write/Edit tool call; it cannot be trusted as agent output.`);
  if (!expectedAgents.includes(w.agentType)) {
    throw new FactoryError(`${file} was last written by "${w.agentType}", but only ${expectedAgents.join('/')} may author it (independent verification).`);
  }
  const mtime = fs.statSync(file).mtimeMs;
  if (mtime - Date.parse(w.ts) > 5 * 60 * 1000) throw new FactoryError(`${file} was modified after its tracked write (possible tampering).`);
  return w;
}

// ---------------------------------------------------------------- submit + verify

export function submitTask(g, taskId) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!t) throw new FactoryError(`Unknown task ${taskId}`);
  assertNoLiveVerify(g, taskId);
  if (t.status !== 'IN_PROGRESS') throw new FactoryError(`${taskId} is ${t.status}; only IN_PROGRESS tasks can be submitted.`);
  const n = t.attempts.length;
  const file = `${inboxDir(g, taskId)}/report-a${n}.json`;
  // The report must come from the attempt's own (dispatch) agent, e.g. game-developer-retry on attempt 2.
  const writer = assertProvenance(file, [t.attempts[n - 1].agent || t.agent]);
  const report = readJson(file);
  const problems = validateReport(report, t, n);
  const commits = git(['log', '--format=%H %s', `develop..${taskBranch(taskId)}`], gameRepo(g)).split('\n').filter(Boolean);
  // The marker covers the whole submit: a concurrent verify/submit of this task is refused from here on.
  const releaseMarker = acquireVerifyMarker(g, taskId, n);
  try {
    // Re-check under the marker: a concurrent submit may have completed between our first check and now.
    const now = loadState(g).tasks[taskId];
    if (now.status !== 'IN_PROGRESS' || now.attempts.length !== n) {
      throw new FactoryError(`${taskId} is ${now.status} (attempt ${now.attempts.length}); it was submitted concurrently. Nothing was changed.`);
    }
    commit(g, [{ type: 'task.submitted', data: { taskId, report: file, reportProblems: problems, commits, writer: writer.agentId } }], { actor: 'orchestrator' });
    return runVerify(g, taskId, { reportProblems: problems });
  } finally {
    releaseMarker();
  }
}

function validateReport(r, t, n) {
  const p = [];
  if (r.taskId !== t.id) p.push(`report.taskId ${r.taskId} != ${t.id}`);
  if (r.attempt !== n) p.push(`report.attempt ${r.attempt} != ${n}`);
  if (!r.summary) p.push('report.summary missing');
  if (!Array.isArray(r.filesChanged)) p.push('report.filesChanged missing');
  if (!Array.isArray(r.acceptance)) p.push('report.acceptance missing');
  else for (const a of t.acceptance) if (!r.acceptance.some((x) => x.id === a.id)) p.push(`report.acceptance lacks ${a.id}`);
  return p;
}

const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API secret key'],
  [/\bpgm_mcp_[A-Za-z0-9]{10,}/, 'Playgama MCP token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'hard-coded credential'],
];

/**
 * (Re-)run the deterministic verification of a submitted task. Refused while another live process verifies
 * the same task (run marker). Infrastructure failures (runs.mjs INFRA_SIGNATURES) leave the task status
 * unchanged, so the attempt is not consumed and `task verify` can simply be re-run.
 */
export function verifyTask(g, taskId, { reportProblems = [] } = {}) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!t) throw new FactoryError(`Unknown task ${taskId}`);
  assertNoLiveVerify(g, taskId);
  if (!['SUBMITTED', 'VERIFY_FAILED'].includes(t.status)) throw new FactoryError(`${taskId} is ${t.status}; verify needs SUBMITTED.`);
  const releaseMarker = acquireVerifyMarker(g, taskId, t.attempts.length);
  try {
    return runVerify(g, taskId, { reportProblems });
  } finally {
    releaseMarker();
  }
}

/** Verification body; the caller holds the task's run marker. One reserved port for all steps of the run. */
function runVerify(g, taskId, { reportProblems = [] } = {}) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!['SUBMITTED', 'VERIFY_FAILED'].includes(t.status)) throw new FactoryError(`${taskId} is ${t.status}; verify needs SUBMITTED.`);
  const n = t.attempts.length;
  const portRes = reservePort(`verify ${g}/${taskId} a${n}`);
  try {
    return runVerifySteps(g, t, n, reportProblems, portRes);
  } finally {
    portRes.release();
  }
}

function runVerifySteps(g, t, n, reportProblems, portRes) {
  const taskId = t.id;
  const port = portRes.port;
  const wt = wtDir(g, taskId);
  const evDir = evidenceDir(g, taskId, n);
  ensureDir(`${evDir}/logs`);
  const cfg = gameConfig(wt);
  /** @type {{name: string, ok: boolean, detail: string, infra?: {id: string, description: string, match: string}}[]} */
  const checks = [];
  const add = (name, ok, detail, infra = null) => checks.push({ name, ok, detail, ...(infra ? { infra } : {}) });

  add('report-schema', reportProblems.length === 0, reportProblems.join('; ') || 'ok');
  const dirty = git(['status', '--porcelain'], wt);
  add('clean-worktree', !dirty, dirty ? `uncommitted changes:\n${dirty}` : 'ok');
  const base = git(['merge-base', 'develop', 'HEAD'], wt);
  const ahead = git(['rev-list', '--count', `${base}..HEAD`], wt);
  add('has-commits', Number(ahead) > 0, `${ahead} commit(s) ahead of develop`);
  const changed = git(['diff', '--name-only', `${base}..HEAD`], wt).split('\n').filter(Boolean);

  const forbidden = [...(cfg.alwaysForbidden || [])];
  for (const ps of PROTECTED_SCOPES) if (!(ps.flag && t[ps.flag])) forbidden.push(ps.glob);
  if (!t.allowDeps) forbidden.push('package.json', 'pnpm-lock.yaml', 'factory.game.json', '.npmrc');
  const outOfScope = changed.filter((f) => !matchesAny(f, t.scope) && !(t.allowDeps && ['package.json', 'pnpm-lock.yaml'].includes(f)));
  const touchedForbidden = changed.filter((f) => matchesAny(f, forbidden));
  add('scope', outOfScope.length === 0 && touchedForbidden.length === 0,
    outOfScope.length || touchedForbidden.length ? `out of scope: ${outOfScope.join(', ') || '-'}; forbidden: ${touchedForbidden.join(', ') || '-'}` : `${changed.length} file(s), all in scope`);

  const added = git(['diff', '-U0', `${base}..HEAD`], wt).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const secrets = [];
  for (const l of added) for (const [re, what] of SECRET_PATTERNS) if (re.test(l)) secrets.push(`${what}: ${l.slice(0, 80)}`);
  add('secret-scan', secrets.length === 0, secrets.join('\n') || 'ok');

  const urls = scanExternalUrls(wt, base, cfg.urlAllowlist || []);
  add('no-external-requests', urls.length === 0, urls.length ? `external URLs in shipped code:\n${urls.map((u) => `${u.file}: ${u.url}`).join('\n')}` : 'ok');

  const stepNames = t.verifySteps || cfg.taskVerify;
  const pm = loadConfig().packageManager;
  for (const name of stepNames) {
    const cmd = cfg.commands[name];
    if (!cmd) { add(`step:${name}`, false, `no command configured for "${name}"`); continue; }
    const r = run(cmd.replace(/^pnpm /, `${pm} `), { cwd: wt, env: { CI: '1', FACTORY_TASK: taskId, ...portRes.env } });
    fs.writeFileSync(`${evDir}/logs/${name}.log`, `$ ${r.cmd}\nexit ${r.exitCode} in ${r.durationMs}ms (E2E_PORT=${port})\n\n${r.output}`);
    // A timed-out step is never infrastructure: a hang is a defect or a flaky test until proven otherwise.
    const infra = r.exitCode !== 0 && !r.timedOut ? classifyFailure(name, r.output) : null;
    add(`step:${name}`, r.exitCode === 0,
      `exit ${r.exitCode} (${(r.durationMs / 1000).toFixed(1)}s)${infra ? ` [infrastructure: ${infra.id}: "${infra.match}"]` : ''}${r.exitCode ? `\n${r.tail}` : ''}`, infra);
    if (name === 'install' && r.exitCode !== 0) break;
  }
  const ok = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  // Infrastructure only when EVERY failed check matched a signature; any genuine failure makes the run a defect.
  const infraOnly = !ok && failed.every((c) => c.infra);
  const head = git(['rev-parse', 'HEAD'], wt);
  const signatures = failed.filter((c) => c.infra).map((c) => ({ check: c.name, id: c.infra?.id, match: c.infra?.match }));
  // Bounded: an attempt gets at most `infraRetriesPerAttempt` infrastructure-classified runs. A signature that
  // keeps matching is most likely caused by the task's own code (e.g. a server that binds twice), so the next
  // one is a normal failure: it consumes the attempt and follows the normal retry/blocking path.
  const infraLimit = infraRetryLimit();
  const infraCount = (t.attempts[n - 1]?.infraFailures || []).length;
  const repeated = infraOnly && infraCount >= infraLimit;
  const outChecks = checks.map((c) => ({
    name: c.name, ok: c.ok, detail: c.ok ? undefined : c.detail,
    classification: c.ok ? undefined : (c.infra ? `${repeated ? 'repeated-infrastructure' : 'infrastructure'}:${c.infra.id}` : 'defect'),
  }));
  if (infraOnly && !repeated) {
    const k = infraCount + 1;
    const evidence = `${evDir}/verify-infra-${k}.json`;
    const logs = `${evDir}/logs-infra-${k}`;
    fs.cpSync(`${evDir}/logs`, logs, { recursive: true });
    writeJsonAtomic(evidence, { taskId, attempt: n, ts: nowIso(), head, base, changed, port, ok: false, classification: 'infrastructure', infraRun: k, infraLimit, signatures, logs, checks });
    commit(g, [{ type: 'task.verify_infra_failed', data: { taskId, attempt: n, evidence, signatures, port, infraRun: k, infraLimit } }], { actor: 'factory-cli' });
    const why = [...new Set(failed.map((c) => c.infra?.description))].join('; ');
    const left = infraLimit - k;
    return {
      taskId, attempt: n, ok: false, infra: true, classification: 'infrastructure', port, infraRun: k, infraLimit,
      summary: `infrastructure failure ${k}/${infraLimit} for attempt ${n} (${signatures.map((x) => `${x.check}: ${x.id}`).join(', ')}); attempt NOT consumed, task stays ${t.status}`,
      checks: outChecks, evidence,
      next: [`fix the environment (${why}), then re-run: factory task verify ${taskId} --game ${g}` +
        (left > 0 ? ` (${left} more infrastructure-classified run(s) allowed for this attempt)` : ' (limit reached: the next matching failure counts as a normal failure and consumes the attempt)')],
    };
  }
  const classification = ok ? 'pass' : repeated ? 'repeated-infrastructure' : 'defect';
  const summary = ok ? `all ${checks.length} checks passed`
    : repeated ? `failed: ${failed.map((c) => c.name).join(', ')} — repeated infrastructure signature (${signatures.map((x) => x.id).join(', ')}) after ${infraCount} infrastructure-classified run(s) of attempt ${n} (limit ${infraLimit}); treated as a defect, likely caused by the task's code`
      : `failed: ${failed.map((c) => c.name).join(', ')}`;
  writeJsonAtomic(`${evDir}/verify.json`, {
    taskId, attempt: n, ts: nowIso(), head, base, changed, port, ok, classification,
    ...(repeated ? { infraRuns: infraCount, infraLimit, signatures } : {}), checks,
  });
  commit(g, [{ type: 'task.verified', data: { taskId, ok, summary, evidence: `${evDir}/verify.json`, ...(repeated ? { classification } : {}) } }], { actor: 'factory-cli' });
  const after = maybeBlock(g, taskId);
  const next = ok ? [`dispatch ${t.reviewer} for ${taskId}, then factory task review ${taskId} --game ${g}`]
    : after ? [`task BLOCKED, human decision needed: ${after}`]
      : [`factory task start ${taskId} --game ${g} (attempt ${n + 1}; feedback goes into the packet)${repeated ? '; the infrastructure signature repeated, so the attempt was consumed: tell the implementer to check its own server/port handling' : ''}`];
  return {
    taskId, attempt: n, ok, classification, port, summary, checks: outChecks, evidence: `${evDir}/verify.json`, blocked: after, next,
    ...(repeated ? { infraRuns: infraCount, infraLimit } : {}),
  };
}

// ---------------------------------------------------------------- review

export function recordReview(g, taskId) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (t.status !== 'VERIFIED') throw new FactoryError(`${taskId} is ${t.status}; only VERIFIED tasks are reviewed (verification must pass first).`);
  const n = t.attempts.length;
  const file = `${inboxDir(g, taskId)}/review-a${n}.json`;
  const writer = assertProvenance(file, [t.reviewer]);
  // Independence is judged on base roles: game-developer-retry and game-developer are the same role.
  const implementer = t.attempts[n - 1].agent || t.agent;
  if (sameBaseRole(writer.agentType, implementer) || sameBaseRole(t.reviewer, t.agent)) {
    throw new FactoryError(`Reviewer ${writer.agentType} and implementer ${implementer} have the same base role; the review is not independent.`);
  }
  const r = readReviewJson(file);
  const problems = r.ok ? validateReview(r.value, reviewContextOf(t)) : [r.error];
  if (problems.length) {
    throw new FactoryError(`Review file ${file} invalid (${problems.length} problem(s)); nothing was recorded:\n  - ${problems.join('\n  - ')}`,
      [`Re-dispatch ${t.reviewer} with the review packet (factory task review-packet ${taskId}); it must pass \`factory review check ${file} --task ${taskId} --game ${g}\` before finishing`]);
  }
  const review = r.value;
  const findings = review.findings;
  const { unmet, serious } = reviewConsequences(review);
  let verdict = review.verdict;
  let override = null;
  if (verdict === 'ACCEPT' && (unmet.length || serious.length)) {
    verdict = 'REJECT';
    override = `ACCEPT overridden: unmet criteria [${unmet.join(', ')}], ${serious.length} critical/major finding(s)`;
  }
  const evDir = evidenceDir(g, taskId, n);
  writeJsonAtomic(`${evDir}/review.json`, { ...review, effectiveVerdict: verdict, override, reviewerAgentId: writer.agentId });
  commit(g, [{ type: 'task.reviewed', data: { taskId, verdict, reviewer: t.reviewer, findings, evidence: `${evDir}/review.json` } }], { actor: 'factory-cli' });
  const blocked = maybeBlock(g, taskId);
  return { taskId, attempt: n, verdict, override, unmet, findings: findings.length, blocked };
}

/** Parse a review file without throwing: { ok, value } or { ok: false, error }. */
export function readReviewJson(file) {
  if (!fs.existsSync(file)) return { ok: false, error: `(file): ${file} does not exist` };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (e) {
    return { ok: false, error: `(file): not valid JSON (${/** @type {any} */ (e).message})` };
  }
}

/** Validation context of a task's current attempt (the attempt being reviewed). */
function reviewContextOf(t) {
  return { taskId: t.id, attempt: t.attempts.length, reviewer: t.reviewer, criteriaIds: t.acceptance.map((a) => a.id), maintenance: false };
}

/** @param {string} g @param {string} taskId */
export function reviewContext(g, taskId) {
  const t = loadState(g).tasks[taskId];
  if (!t) throw new FactoryError(`Unknown task ${taskId} in ${g}.`);
  if (!t.attempts.length) throw new FactoryError(`${taskId} has no attempt yet; there is nothing to review.`);
  return reviewContextOf(t);
}

/**
 * Orchestrator: write `<inbox>/<g>/<task>/review-packet-a<n>.md` — everything the reviewer needs (task, attempt,
 * implementer, diff command, verify evidence, acceptance criteria, the exact schema, output path, self-check).
 * The reviewer is dispatched with that path only.
 */
export function writeReviewPacket(g, taskId) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!t) throw new FactoryError(`Unknown task ${taskId}`);
  if (t.status !== 'VERIFIED') throw new FactoryError(`${taskId} is ${t.status}; review packets are written for VERIFIED tasks (verification must pass first).`);
  const n = t.attempts.length;
  const a = t.attempts[n - 1];
  const wt = t.worktree || wtDir(g, taskId);
  const ib = inboxDir(g, taskId);
  const out = `${ib}/review-a${n}.json`;
  const evidence = a.verify?.evidence || `${evidenceDir(g, taskId, n)}/verify.json`;
  const ctx = reviewContextOf(t);
  const cli = `node "${paths().root}/factory/cli/factory.mjs"`;
  const text = [
    `# Review packet ${taskId} (attempt ${n}/${t.maxAttempts})`,
    '',
    `- Dispatch to: ${t.reviewer} (subagent_type "${t.reviewer}"; never pass model or effort on the Agent call)`,
    `- Game: ${g} — ${s.title}`,
    `- Task: ${taskId} — ${t.title} (phase ${t.phase}, risk ${t.risk})`,
    `- Attempt: ${n}`,
    `- Implementer (this attempt): ${a.agent || t.agent}; independent reviewer: ${t.reviewer}`,
    `- Worktree (read-only for you): \`${wt}\``,
    `- Diff: \`cd "${wt}" && git diff develop...${taskBranch(taskId)}\` (commits: \`git log develop..${taskBranch(taskId)} --oneline\`)`,
    `- Verification evidence (produced by the factory CLI): \`${evidence}\``,
    `- Task packet (what the implementer was asked to do): \`${ib}/packet-a${n}.md\``,
    `- Implementer report (informational, not evidence): \`${ib}/report-a${n}.json\``,
    `- Output: write the review with the Write tool to \`${out}\``,
    '',
    '## Description',
    t.description,
    '',
    '## Acceptance criteria (assess every id exactly once in `criteria`)',
    ...t.acceptance.map((x) => `- **${x.id}** [${x.check}${x.ref ? `: ${x.ref}` : ''}] ${x.text}`),
    '',
    '## Procedure',
    '1. Read the diff and the changed files; read the verification evidence; run targeted tests yourself if useful. Do not modify files.',
    '2. Assess each criterion with concrete evidence (test name, file:line, evidence log); list findings with a file, the problem and the required fix.',
    `3. Write \`${out}\` with the Write tool, exactly in the schema below.`,
    `4. Self-check before finishing (records nothing): \`${cli} review check "${out}" --task ${taskId} --game ${g}\`. Fix every listed problem and re-run until it prints OK.`,
    '',
    '## Review schema',
    renderReviewSchema(ctx),
    '',
  ].join('\n');
  ensureDir(ib);
  const file = `${ib}/review-packet-a${n}.md`;
  writeTextAtomic(file, text);
  return { taskId, attempt: n, dispatchTo: t.reviewer, packet: file, output: out, next: `factory task review ${taskId} --game ${g}` };
}

// ---------------------------------------------------------------- integrate

export function integrateTask(g, taskId) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (t.status !== 'ACCEPTED') throw new FactoryError(`${taskId} is ${t.status}; only ACCEPTED (verified + independently reviewed) tasks integrate.`);
  const release = acquireLock(`${gameDir(g)}/.integration.lock`, { staleMs: 60 * 60 * 1000, timeoutMs: 5000 });
  try {
    const iwt = ensureIntegrationWorktree(g);
    const n = t.attempts.length;
    const evDir = evidenceDir(g, taskId, n);
    ensureDir(`${evDir}/logs`);
    const before = git(['rev-parse', 'HEAD'], iwt);
    const m = git(['merge', '--no-ff', '--no-edit', '-m', `integrate(${taskId}): ${t.title} [attempt ${n}]`, taskBranch(taskId)], iwt, { allowFail: true });
    if (m.code !== 0) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'], iwt, { allowFail: true }).out;
      git(['merge', '--abort'], iwt, { allowFail: true });
      writeJsonAtomic(`${evDir}/integration.json`, { ok: false, conflict: true, conflicts, output: m.err || m.out });
      commit(g, [{ type: 'task.integration_failed', data: { taskId, conflict: true, reason: `merge conflict in: ${conflicts || 'unknown'}`, evidence: `${evDir}/integration.json` } }]);
      return { taskId, ok: false, conflict: true, conflicts, blocked: maybeBlock(g, taskId) };
    }
    const merge = git(['rev-parse', 'HEAD'], iwt);
    const cfg = gameConfig(iwt);
    const results = [];
    const pm = loadConfig().packageManager;
    const portRes = reservePort(`integrate ${g}/${taskId} a${n}`);
    const port = portRes.port;
    try {
      for (const name of cfg.regression) {
        const r = run(cfg.commands[name].replace(/^pnpm /, `${pm} `), { cwd: iwt, env: { CI: '1', ...portRes.env } });
        fs.writeFileSync(`${evDir}/logs/regression-${name}.log`, `$ ${r.cmd}\nexit ${r.exitCode} (E2E_PORT=${port})\n\n${r.output}`);
        results.push({ name, ok: r.exitCode === 0, exitCode: r.exitCode, durationMs: r.durationMs, tail: r.exitCode ? r.tail : undefined });
        if (r.exitCode !== 0) break;
      }
    } finally {
      portRes.release();
    }
    const ok = results.every((r) => r.ok);
    if (!ok) {
      git(['revert', '-m', '1', '--no-edit', merge], iwt);
      const revert = git(['rev-parse', 'HEAD'], iwt);
      const failed = results.find((r) => !r.ok);
      writeJsonAtomic(`${evDir}/integration.json`, { ok: false, conflict: false, before, merge, revert, port, results });
      commit(g, [{ type: 'task.integration_failed', data: { taskId, conflict: false, reason: `regression step "${failed.name}" failed after merge`, revert, evidence: `${evDir}/integration.json` } }]);
      return { taskId, ok: false, conflict: false, regressionFailed: failed.name, reverted: revert, blocked: maybeBlock(g, taskId) };
    }
    writeJsonAtomic(`${evDir}/integration.json`, { ok: true, before, merge, port, results });
    commit(g, [{ type: 'task.integrated', data: { taskId, merge, evidence: `${evDir}/integration.json` } }]);
    return { taskId, ok: true, merge, port, regression: results.map((r) => `${r.name}:ok`) };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- blockers

/** After a failure, block the task when its attempt budget is spent. Returns blocker path or null. */
function maybeBlock(g, taskId) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!TASK_RETRYABLE.has(t.status) || t.attempts.length < t.maxAttempts) return null;
  const file = `${gameDir(g)}/reports/blocker-${taskId}.md`;
  writeTextAtomic(file, renderBlocker(g, s, t));
  commit(g, [{ type: 'task.blocked', data: { taskId, report: file } }]);
  return file;
}

function renderBlocker(g, s, t) {
  const out = [
    `# BLOCKER: ${t.id} — ${t.title}`,
    '',
    `Game: ${g} | Phase: ${t.phase} | Agent: ${t.agent} | Reviewer: ${t.reviewer} | Attempts: ${t.attempts.length}/${t.maxAttempts}`,
    `Worktree preserved at: ${t.worktree} (branch ${t.branch})`,
    '',
    '## Failed acceptance criteria / checks per attempt',
  ];
  for (const a of t.attempts) {
    out.push(`### Attempt ${a.n} (agent ${a.agent}${a.model ? `, model ${a.model}` : ''})`);
    if (a.verify) out.push(`- Verification: ${a.verify.ok ? 'passed' : 'FAILED — ' + a.verify.summary} (${a.verify.evidence})`);
    if (a.review) {
      out.push(`- Review: ${a.review.verdict} (${a.review.evidence})`);
      for (const f of Array.isArray(a.review.findings) ? a.review.findings : []) out.push(`  - ${formatFinding(f)}`);
    }
    if (a.integration) out.push(`- Integration: ${a.integration.conflict ? 'CONFLICT' : 'REGRESSION'} — ${a.integration.reason}${a.integration.revert ? ` (reverted ${a.integration.revert.slice(0, 10)})` : ''}`);
  }
  out.push('', '## Acceptance criteria', ...t.acceptance.map((a) => `- ${a.id}: ${a.text}`), '',
    '## Root cause analysis', '_Pending: the orchestrator appends analysis via `factory task blocker-note`._', '',
    '## Required human decision',
    `- \`/retry-task ${t.id}\` — grant more attempts (after the proposed resolution is accepted)`,
    `- \`/abandon-task ${t.id}\` — drop the task (dependents must be re-planned)`,
    '- `/modify-requirements <text>` — change the requirement that cannot be met');
  return out.join('\n');
}

export function blockerNote(g, taskId) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (t.status !== 'BLOCKED') throw new FactoryError(`${taskId} is not BLOCKED.`);
  const note = `${inboxDir(g, taskId)}/blocker-analysis.md`;
  if (!fs.existsSync(note)) throw new FactoryError(`Write the analysis (root cause, evidence, proposed resolution) to ${note} first.`);
  const report = fs.readFileSync(t.blocker, 'utf8').replace(/## Root cause analysis[\s\S]*?(?=## Required human decision)/, `## Root cause analysis\n${fs.readFileSync(note, 'utf8').trim()}\n\n`);
  writeTextAtomic(t.blocker, report);
  return t.blocker;
}

/** Called from the subagent's first Bash call; the hook records agent_id -> task. Prints the packet. */
export function claimInfo(g, taskId) {
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!t || t.status !== 'IN_PROGRESS') throw new FactoryError(`${taskId} is not IN_PROGRESS; nothing to claim.`);
  const n = t.attempts.length;
  return fs.readFileSync(`${inboxDir(g, taskId)}/packet-a${n}.md`, 'utf8');
}

export function isInsideWorktreeOf(file, g, taskId) {
  return samePathPrefix(file, wtDir(g, taskId));
}
