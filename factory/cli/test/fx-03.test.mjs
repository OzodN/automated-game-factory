// @ts-check
/**
 * FX-03 (FD-08) — a free TCP port per factory run, a live verification run marker, and infrastructure
 * failures that do not consume an attempt.
 * A temp game in DEVELOPMENT is built from a probe template whose only real step (`e2e`) is a node script
 * driven by FX03_MODE: it records the E2E_PORT it received, sleeps, really hits EADDRINUSE on its port,
 * or fails like an ordinary test (assertion failure / test timeout).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../factory.mjs');
const FIX = path.join(HERE, 'fixtures');
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx03-'));
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_TEMPLATES_DIR: `${TMP}/templates`, FACTORY_KIT_DIR: `${FIX}/kit`, FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 10, maxActiveAgents: 10, packageManager: 'corepack pnpm', models: REAL_CFG.models }));

// Probe template: install is a no-op, e2e is the probe.
const TPL = `${TMP}/templates/probe`;
fs.mkdirSync(`${TPL}/src`, { recursive: true });
fs.writeFileSync(`${TPL}/factory.game.json`, JSON.stringify({
  template: 'probe', distDir: 'dist',
  commands: { install: 'node -e 0', e2e: 'node probe.mjs' },
  taskVerify: ['install', 'e2e'], regression: ['install', 'e2e'], checkpoint: ['install', 'e2e'], release: ['install', 'e2e'],
  alwaysForbidden: [], urlAllowlist: ['^https?://localhost'],
}, null, 2));
fs.writeFileSync(`${TPL}/_gitignore`, 'dist/\nnode_modules/\n');
fs.writeFileSync(`${TPL}/src/main.js`, 'export {};\n');
fs.writeFileSync(`${TPL}/probe.mjs`, `import fs from 'node:fs';
import net from 'node:net';
const mode = process.env.FX03_MODE || 'ok';
const port = process.env.E2E_PORT || '';
if (process.env.FX03_OUT) fs.appendFileSync(process.env.FX03_OUT, JSON.stringify({ port, task: process.env.FACTORY_TASK || null, mode }) + '\\n');
if (mode === 'ok') process.exit(0);
else if (mode === 'sleep') setTimeout(() => process.exit(0), Number(process.env.FX03_SLEEP || 2000));
else if (mode === 'eaddrinuse') {
  // A real collision: hold E2E_PORT, then bind it again (what a second web server on the same port sees).
  const a = net.createServer();
  a.listen(Number(port), '127.0.0.1', () => {
    const b = net.createServer();
    b.once('error', (e) => { console.error('[WebServer] Error: ' + e.message); process.exit(1); });
    b.listen(Number(port), '127.0.0.1', () => { console.error('second bind unexpectedly succeeded'); process.exit(3); });
  });
} else if (mode === 'fail') { console.error('  1) GD-001 boots the game\\n     Error: expect(received).toBe(expected)\\n  1 failed'); process.exit(1); }
else if (mode === 'timeout') { console.error('  1) GD-002 reaches the menu\\n     Test timeout of 30000ms exceeded.\\n  1 failed'); process.exit(1); }
else process.exit(2);
`);

const { paths, git } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const T = await import('../lib/tasks.mjs');
const R = await import('../lib/runs.mjs');
const { recover, nextActions } = await import('../lib/reports.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');

const GAME = 'fx03-game';
const OUT = `${TMP}/probe-out.jsonl`;
process.env.FX03_OUT = OUT;
const probeRuns = () => (fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function agentWrite(file, content, who) {
  const r = decide({ tool_name: 'Write', agent_id: who.id, agent_type: who.type, tool_input: { file_path: file }, cwd: TMP });
  assert.equal(r.decision, null, `write denied: ${r.reason}`);
  applyEffects(r.effects);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function claim(taskId, who) {
  const r = decide({ tool_name: 'Bash', agent_id: who.id, agent_type: who.type, tool_input: { command: `node factory/cli/factory.mjs task claim ${taskId} --game ${GAME}` } });
  assert.equal(r.decision, null, r.reason);
  applyEffects(r.effects);
}
function commitIn(wt, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${wt}/${rel}`), { recursive: true });
    fs.writeFileSync(`${wt}/${rel}`, content);
  }
  git(['add', '-A'], wt);
  git(['commit', '-q', '-m', msg], wt);
}
/** Start, claim, commit and report attempt 1 of a task; the task is then ready to submit. */
function prepare(taskId) {
  const who = { id: `dev-${taskId}`, type: 'game-developer' };
  T.startTask(GAME, taskId);
  claim(taskId, who);
  commitIn(T.wtDir(GAME, taskId), { [`src/${taskId.toLowerCase()}/m.js`]: `export const v = '${taskId}';\n` }, `feat(${taskId}): module`);
  agentWrite(`${paths().inbox}/${GAME}/${taskId}/report-a1.json`, JSON.stringify({
    taskId, attempt: 1, agent: who.type, summary: 'done', filesChanged: [], testsRun: [],
    acceptance: [{ id: 'AC1', status: 'met', evidence: 'test' }], knownLimitations: [], unresolvedDefects: [],
  }), who);
}
/** Record the submission only (as if `task submit` was interrupted before or during verification). */
function markSubmitted(taskId) {
  S.commit(GAME, [{ type: 'task.submitted', data: { taskId, report: `${paths().inbox}/${GAME}/${taskId}/report-a1.json`, reportProblems: [], commits: [] } }], { actor: 'orchestrator' });
}
const status = (id) => S.loadState(GAME).tasks[id];
const events = () => fs.readFileSync(`${S.gameDir(GAME)}/events.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
/** A live process to own a marker, and a pid that is certainly dead. */
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '0']); return r.pid; };
/** Age a run file past the creation grace period (RUN_FILE_GRACE_MS). */
const age = (file, ms = 60000) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
function cliVerify(taskId, extraEnv) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'task', 'verify', taskId, '--game', GAME, '--json'], { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const task = (id) => ({
  id, phase: 1, title: `Task ${id}`, description: `Implement ${id} exactly as described in the specification section.`, agent: 'game-developer', reviewer: 'code-reviewer',
  deps: [], scope: [`src/${id.toLowerCase()}/**`], acceptance: [{ id: 'AC1', text: `${id} module exports a value`, check: 'review' }], tests: ['unit'], risk: 'low',
});

test('setup: a game in DEVELOPMENT scaffolded from the probe template', () => {
  G.newGame(GAME, 'FX03 Game');
  const repo = T.gameRepo(GAME);
  git(['branch', 'develop', 'main'], repo);
  const iwt = T.ensureIntegrationWorktree(GAME);
  G.renderTemplate(TPL, iwt, GAME, 'FX03 Game');
  git(['add', '-A'], iwt);
  git(['commit', '-q', '-m', 'chore: scaffold probe'], iwt);
  S.commit(GAME, [
    { type: 'concept.approved', data: { hash: 'h' } }, { type: 'spec.started' }, { type: 'spec.approved', data: { hash: 'h' } }, { type: 'dev.authorized', data: { hash: 'h' } },
  ]);
  const plan = `${TMP}/plan.json`;
  fs.writeFileSync(plan, JSON.stringify({
    phases: [{ n: 1, name: 'Probe', goal: 'probe', exitCriteria: ['e2e suite exits 0'] }],
    tasks: ['A1', 'A2', 'B1', 'C1', 'D1', 'E1'].map(task),
  }));
  assert.equal(G.loadPlan(GAME, plan).state.mode, 'DEVELOPMENT');
});

test('ports: allocation binds port 0 and returns a usable port; held reservations never repeat', () => {
  const p = R.allocatePort();
  assert.ok(Number.isInteger(p) && p > 0 && p < 65536);
  const a = R.reservePort('test a');
  const b = R.reservePort('test b');
  try {
    assert.notEqual(a.port, b.port);
    assert.deepEqual(a.env, { E2E_PORT: String(a.port) });
    assert.ok(R.liveReservedPorts().includes(a.port) && R.liveReservedPorts().includes(b.port));
    assert.notEqual(R.allocatePort([a.port, b.port]), a.port);
  } finally {
    a.release();
    b.release();
  }
  assert.deepEqual(R.liveReservedPorts(), [], 'released');
  // A reservation left by a dead process is stale and dropped.
  const dead = `${R.portsDir()}/1.json`;
  fs.writeFileSync(dead, JSON.stringify({ port: 1, pid: deadPid(), host: os.hostname(), ts: new Date().toISOString() }));
  assert.deepEqual(R.liveReservedPorts(), [1], 'a very new reservation is live even with a dead pid (it may be mid-creation)');
  age(dead);
  assert.deepEqual(R.liveReservedPorts(), []);
  assert.ok(!fs.existsSync(`${R.portsDir()}/1.json`));
});

test('two concurrent verify runs get different ports, passed as E2E_PORT and recorded in the evidence', async () => {
  prepare('A1');
  prepare('A2');
  markSubmitted('A1');
  markSubmitted('A2');
  fs.rmSync(OUT, { force: true });
  const [r1, r2] = await Promise.all([cliVerify('A1', { FX03_MODE: 'sleep', FX03_SLEEP: '2500' }), cliVerify('A2', { FX03_MODE: 'sleep', FX03_SLEEP: '2500' })]);
  assert.equal(r1.code, 0, r1.err);
  assert.equal(r2.code, 0, r2.err);
  const v1 = JSON.parse(r1.out);
  const v2 = JSON.parse(r2.out);
  assert.equal(v1.ok, true, JSON.stringify(v1.checks));
  assert.equal(v2.ok, true, JSON.stringify(v2.checks));
  assert.notEqual(v1.port, v2.port, 'concurrent runs never share a port');
  const seen = Object.fromEntries(probeRuns().map((x) => [x.task, Number(x.port)]));
  assert.equal(seen.A1, v1.port, 'the step received the run port as E2E_PORT');
  assert.equal(seen.A2, v2.port);
  assert.equal(JSON.parse(fs.readFileSync(v1.evidence, 'utf8')).port, v1.port, 'port recorded in verify.json');
  assert.match(fs.readFileSync(`${path.dirname(v1.evidence)}/logs/e2e.log`, 'utf8'), new RegExp(`E2E_PORT=${v1.port}`));
  assert.equal(status('A1').status, 'VERIFIED');
  assert.ok(!fs.existsSync(R.verifyMarkerPath(GAME, 'A1')), 'marker removed after the run');
  assert.deepEqual(R.liveReservedPorts(), [], 'port reservations released');
});

test('a live verification marker refuses a second verify/submit; recover says "verifying"; a dead marker is ignored', async () => {
  prepare('B1');
  markSubmitted('B1');
  assert.equal(recover().find((x) => x.task === 'B1')?.kind, 'submitted-unverified', 'no marker: interrupted/never verified');

  const live = sleeper();
  try {
    await new Promise((r) => live.once('spawn', r));
    const marker = { pid: live.pid, host: os.hostname(), ts: new Date().toISOString(), task: 'B1', attempt: 1 };
    fs.mkdirSync(path.dirname(R.verifyMarkerPath(GAME, 'B1')), { recursive: true });
    fs.writeFileSync(R.verifyMarkerPath(GAME, 'B1'), JSON.stringify(marker));
    assert.throws(() => T.verifyTask(GAME, 'B1'), new RegExp(`verification of B1 already running \\(pid ${live.pid}`, 'i'));
    assert.throws(() => T.submitTask(GAME, 'B1'), /already running/);
    const f = recover().find((x) => x.task === 'B1');
    assert.equal(f.kind, 'verifying');
    assert.match(f.detail, new RegExp(`pid ${live.pid}`));
    assert.match(f.fix, /wait/);
    assert.ok(nextActions(S.loadState(GAME)).some((a) => a.cmd.startsWith('wait: verification of B1')));
    assert.equal(status('B1').status, 'SUBMITTED', 'refusal changed nothing');
    assert.match(f.fix, /--clear-verify-marker B1/, 'escape hatch for a reused pid is printed');
    // Operator escape hatch (pid reuse): only with --apply; the marker is archived, not lost.
    assert.ok(recover({ clearVerifyMarkers: ['B1'] }).some((x) => x.task === 'B1' && x.kind === 'verifying'), 'no clearing without --apply');
    const c = recover({ apply: true, clearVerifyMarkers: ['B1'], game: GAME }).find((x) => x.task === 'B1');
    assert.equal(c.kind, 'verify-marker-cleared');
    assert.ok(!fs.existsSync(R.verifyMarkerPath(GAME, 'B1')));
    assert.equal(fs.readdirSync(`${path.dirname(R.verifyMarkerPath(GAME, 'B1'))}/cleared`).length, 1);
  } finally {
    live.kill();
  }
  await new Promise((r) => (live.exitCode !== null || live.signalCode ? r(null) : live.once('exit', r)));
  // A marker left by a process that died (older than the creation grace period) is stale.
  fs.writeFileSync(R.verifyMarkerPath(GAME, 'B1'), JSON.stringify({ pid: live.pid, host: os.hostname(), ts: new Date().toISOString(), task: 'B1', attempt: 1 }));
  age(R.verifyMarkerPath(GAME, 'B1'));

  const f2 = recover().find((x) => x.task === 'B1');
  assert.equal(f2.kind, 'submitted-unverified', 'dead marker: interrupted verification');
  assert.match(f2.detail, /stale marker/);
  assert.match(f2.fix, /task verify B1/);
  process.env.FX03_MODE = 'ok';
  try {
    const v = T.verifyTask(GAME, 'B1');
    assert.equal(v.ok, true, JSON.stringify(v.checks));
  } finally {
    delete process.env.FX03_MODE;
  }
  assert.equal(status('B1').status, 'VERIFIED');
  assert.ok(!fs.existsSync(R.verifyMarkerPath(GAME, 'B1')));
});

test('a real EADDRINUSE is an infrastructure failure: task stays SUBMITTED, attempt not consumed, re-verify passes', () => {
  prepare('C1');
  process.env.FX03_MODE = 'eaddrinuse';
  let v;
  try {
    v = T.submitTask(GAME, 'C1');
  } finally {
    delete process.env.FX03_MODE;
  }
  assert.equal(v.ok, false);
  assert.equal(v.infra, true, JSON.stringify(v.checks));
  assert.equal(v.classification, 'infrastructure');
  assert.match(v.summary, /attempt NOT consumed/);
  assert.equal(v.checks.find((c) => c.name === 'step:e2e').classification, 'infrastructure:port-in-use');
  assert.match(v.next[0], /task verify C1/);
  const t = status('C1');
  assert.equal(t.status, 'SUBMITTED');
  assert.equal(t.attempts.length, 1, 'attempts unchanged');
  assert.equal(t.attempts[0].verify, undefined, 'no verification verdict recorded');
  assert.equal(t.attempts[0].infraFailures.length, 1);
  assert.equal(t.attempts[0].infraFailures[0].signatures[0].id, 'port-in-use');
  const ev = events().filter((e) => e.type === 'task.verify_infra_failed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.evidence, v.evidence);
  assert.ok(fs.existsSync(v.evidence));
  assert.equal(JSON.parse(fs.readFileSync(v.evidence, 'utf8')).signatures[0].id, 'port-in-use');
  assert.ok(nextActions(S.loadState(GAME)).some((a) => a.cmd === 'factory task verify C1' && /infrastructure failure \(port-in-use\)/.test(a.why)));
  assert.match(recover().find((x) => x.task === 'C1').detail, /infrastructure failure/);

  process.env.FX03_MODE = 'ok';
  try {
    assert.equal(T.verifyTask(GAME, 'C1').ok, true);
  } finally {
    delete process.env.FX03_MODE;
  }
  assert.equal(status('C1').status, 'VERIFIED');
  assert.equal(status('C1').attempts.length, 1);
});

test('ordinary failing tests and test timeouts still yield VERIFY_FAILED (no masking of flaky tests)', () => {
  prepare('D1');
  process.env.FX03_MODE = 'fail';
  let v;
  try {
    v = T.submitTask(GAME, 'D1');
  } finally {
    delete process.env.FX03_MODE;
  }
  assert.equal(v.ok, false);
  assert.ok(!v.infra);
  assert.equal(v.classification, 'defect');
  assert.equal(v.checks.find((c) => c.name === 'step:e2e').classification, 'defect');
  assert.equal(status('D1').status, 'VERIFY_FAILED');
  assert.match(v.next[0], /task start D1/);

  process.env.FX03_MODE = 'timeout';
  try {
    v = T.verifyTask(GAME, 'D1');
  } finally {
    delete process.env.FX03_MODE;
  }
  assert.equal(v.classification, 'defect', 'a test timeout is not infrastructure');
  assert.equal(status('D1').status, 'VERIFY_FAILED');
});

test('infrastructure classification is bounded per attempt: a repeating EADDRINUSE ends in VERIFY_FAILED and consumes the attempt', () => {
  assert.equal(R.infraRetryLimit({}), 2, 'default');
  assert.equal(R.infraRetryLimit({ infraRetriesPerAttempt: 0 }), 0);
  assert.equal(R.infraRetryLimit({ infraRetriesPerAttempt: -1 }), 2, 'invalid -> default');
  prepare('E1');
  process.env.FX03_MODE = 'eaddrinuse';
  let v1; let v2; let v3;
  try {
    v1 = T.submitTask(GAME, 'E1');
    v2 = T.verifyTask(GAME, 'E1');
  } finally {
    delete process.env.FX03_MODE;
  }
  assert.equal(v1.infra, true);
  assert.equal(v1.infraRun, 1);
  assert.equal(v1.infraLimit, 2);
  assert.match(v1.summary, /infrastructure failure 1\/2/);
  assert.match(v1.next[0], /1 more infrastructure-classified run/);
  assert.equal(v2.infra, true);
  assert.equal(v2.infraRun, 2);
  assert.match(v2.next[0], /limit reached/);
  assert.equal(status('E1').status, 'SUBMITTED');
  assert.ok(nextActions(S.loadState(GAME)).some((a) => a.cmd === 'factory task verify E1' && /2\/2 infrastructure run\(s\) used.*limit reached/.test(a.why)));
  assert.match(recover().find((x) => x.task === 'E1').detail, /2\/2 infrastructure run/);
  process.env.FX03_MODE = 'eaddrinuse';
  try {
    v3 = T.verifyTask(GAME, 'E1');
  } finally {
    delete process.env.FX03_MODE;
  }

  assert.equal(v3.ok, false);
  assert.ok(!v3.infra, 'third matching run is not infrastructure any more');
  assert.equal(v3.classification, 'repeated-infrastructure');
  assert.equal(v3.infraRuns, 2);
  assert.equal(v3.checks.find((c) => c.name === 'step:e2e').classification, 'repeated-infrastructure:port-in-use');
  assert.match(v3.summary, /repeated infrastructure signature \(port-in-use\)/);
  assert.match(v3.next[0], /task start E1 .*attempt was consumed/);
  const t = status('E1');
  assert.equal(t.status, 'VERIFY_FAILED', 'normal retry path');
  assert.equal(t.attempts.length, 1);
  assert.equal(t.attempts[0].infraFailures.length, 2);
  assert.match(t.attempts[0].verify.summary, /repeated infrastructure/, 'feedback reaches the next packet');
  const ev = JSON.parse(fs.readFileSync(v3.evidence, 'utf8'));
  assert.equal(ev.classification, 'repeated-infrastructure');
  assert.equal(ev.infraRuns, 2);
});

test('run files: atomic exclusive creation; unreadable or very new files are live; stale replacement never deletes a live file', () => {
  const dir = `${TMP}/runfiles`;
  const f = `${dir}/x.json`;
  assert.equal(R.runFileState(f).state, 'none');
  assert.equal(R.createExclusiveJson(f, { pid: deadPid(), host: os.hostname(), ts: new Date().toISOString() }), true);
  assert.equal(R.createExclusiveJson(f, { pid: 1 }), false, 'exclusive');
  assert.deepEqual(fs.readdirSync(dir), ['x.json'], 'no temp files left behind');
  assert.equal(R.runFileState(f).state, 'live', 'very new: live');
  age(f);
  assert.equal(R.runFileState(f).state, 'stale', 'dead pid, past the grace period');
  fs.writeFileSync(f, '{ torn');
  age(f);
  assert.equal(R.runFileState(f).state, 'live', 'unreadable: live (until RUN_MAX_AGE_MS)');
  age(f, R.RUN_MAX_AGE_MS + 60000);
  assert.equal(R.runFileState(f).state, 'stale');
  // A live file that replaced the stale one meanwhile is put back, not deleted.
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, host: os.hostname(), ts: new Date().toISOString() }));
  assert.equal(R.removeStaleRunFile(f), false);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, process.pid);
  fs.writeFileSync(f, JSON.stringify({ pid: deadPid(), host: os.hostname(), ts: new Date().toISOString() }));
  assert.equal(R.removeStaleRunFile(f), true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('recover: an integration lock being created (no owner yet) is live, not stale', async () => {
  const { integrationLockState } = await import('../lib/reports.mjs');
  const lock = `${S.gameDir(GAME)}/.integration.lock`;
  fs.mkdirSync(lock);
  try {
    assert.equal(integrationLockState(lock).state, 'live');
    assert.equal(recover().find((x) => x.kind === 'integrating' || x.kind === 'stale-integration-lock')?.kind, 'integrating');
    age(lock);
    assert.equal(integrationLockState(lock).state, 'stale');
    fs.writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    assert.equal(integrationLockState(lock).state, 'live');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  assert.equal(integrationLockState(lock).state, 'none');
});

test('integration regression runs on its own reserved port, recorded in the evidence', () => {
  const rev = { id: 'rev1', type: 'code-reviewer' };
  agentWrite(`${paths().inbox}/${GAME}/A1/review-a1.json`, JSON.stringify({
    taskId: 'A1', attempt: 1, reviewer: rev.type, verdict: 'ACCEPT', criteria: [{ id: 'AC1', met: true, evidence: 'read' }], findings: [], summary: 's',
  }), rev);
  assert.equal(T.recordReview(GAME, 'A1').verdict, 'ACCEPT');
  fs.rmSync(OUT, { force: true });
  const i = T.integrateTask(GAME, 'A1');
  assert.equal(i.ok, true);
  assert.ok(Number.isInteger(i.port));
  const ev = JSON.parse(fs.readFileSync(`${S.gameDir(GAME)}/evidence/A1/a1/integration.json`, 'utf8'));
  assert.equal(ev.port, i.port);
  assert.deepEqual(probeRuns().map((x) => Number(x.port)), [i.port], 'regression step received the run port');
  assert.deepEqual(R.liveReservedPorts(), []);
});

test('infrastructure signatures are data and classify only environment problems', () => {
  for (const sig of R.INFRA_SIGNATURES) {
    assert.ok(sig.id && sig.description && Array.isArray(sig.patterns) && sig.patterns.length, sig.id);
    for (const p of sig.patterns) assert.doesNotThrow(() => new RegExp(p, 'i'));
  }
  const c = (step, out) => R.classifyFailure(step, out)?.id ?? null;
  assert.equal(c('e2e', 'Error: http://localhost:4123/index.html is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true'), 'port-in-use');
  assert.equal(c('e2e', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:4100'), 'port-in-use');
  assert.equal(c('e2e', "browserType.launch: Executable doesn't exist at C:\\pw\\chromium-1100\\chrome.exe"), 'browser-unavailable');
  assert.equal(c('build', 'Error: ENOSPC: no space left on device, write'), 'disk-full');
  assert.equal(c('install', 'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/x: request to ... failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'), 'install-network');
  assert.equal(c('e2e', 'connect ECONNREFUSED 127.0.0.1:4100'), null, 'network errors count only for the install step');
  assert.equal(c('e2e', 'Test timeout of 30000ms exceeded.'), null);
  assert.equal(c('unit', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal'), null);
  assert.equal(c('e2e', 'TimeoutError: page.waitForSelector: Timeout 8000ms exceeded.'), null);
  // Only the failure region (the end of the output) counts: an early EADDRINUSE before a real failure is not infra.
  const noise = ['[fixture] Error: listen EADDRINUSE: address already in use 127.0.0.1:9000 (retrying on another port)',
    ...Array.from({ length: R.FAILURE_REGION_LINES + 5 }, (_, i) => `  ok ${i + 1} GD-${i} passes`),
    '  1) GD-099 shows the score', '     Error: expect(received).toBe(expected)', '  1 failed'].join('\n');
  assert.equal(c('e2e', noise), null);
  assert.equal(R.failureRegion(noise).split('\n').length, R.FAILURE_REGION_LINES);
  assert.equal(c('e2e', `${noise}\nError: http://localhost:4100 is already used, make sure that nothing is running on the port/url`), 'port-in-use', 'at the end it counts');
});

test.after(() => {
  if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP}`);
});
