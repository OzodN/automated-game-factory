// @ts-check
/**
 * FX-01 — one review schema, strictly validated (FD-02, FD-03).
 * Pure validator: pilot-style bad reviews are refused with path-level messages and "did you mean" hints;
 * every problem is listed at once; a valid review passes; maintenance profile; brief acceptance ids;
 * findings never render as `undefined`; code-reviewer.md's example matches the module.
 * End to end (real git, fixture template): review packet, `task review` refuses an invalid file without
 * recording, `review check` (CLI, read-only, allowed for subagents), the retry packet and the blocker report
 * show the real issue / required_fix text; maintenance merge uses the same validator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const CLI = path.resolve(HERE, '../factory.mjs');
const HOOKS = path.resolve(HERE, '../../hooks');
const REAL_ROOT = path.resolve(HERE, '../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx01-'));
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_TEMPLATES_DIR: `${FIX}/templates`, FACTORY_KIT_DIR: `${FIX}/kit`, FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 2, maxActiveAgents: 3, packageManager: 'corepack pnpm', release: { maxBytes: 1e8, maxFiles: 1000, maxFileBytes: 1e7 }, models: REAL_CFG.models }));

const R = await import('../lib/review-schema.mjs');
const { paths, git } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const T = await import('../lib/tasks.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');

const GAME = 'review-game';
const CTX = { taskId: 'P1-AUDIO-02', attempt: 1, reviewer: 'tech-architect', criteriaIds: ['AC1', 'AC2'] };
const valid = () => ({
  taskId: 'P1-AUDIO-02', attempt: 1, reviewer: 'tech-architect', verdict: 'REJECT', summary: 'AC2 is not covered by a real test.',
  criteria: [{ id: 'AC1', met: true, evidence: 'tests/unit/assets.test.ts "audio files" asserts 8 names' }, { id: 'AC2', met: false, evidence: 'the equality assertion is skipped silently' }],
  findings: [{ severity: 'major', file: 'tests/unit/assets.test.ts', line: 40, issue: 'Silent skip hides lost coverage.', required_fix: 'Assert against a golden string.' }],
  notes: '',
});

// ---------------------------------------------------------------- pure validator

test('a valid review passes; the module example and the maintenance example are valid', () => {
  assert.deepEqual(R.validateReview(valid(), CTX), []);
  assert.deepEqual(R.validateReview(R.reviewExample(), {}), []);
  assert.deepEqual(R.validateReview(R.reviewExample(CTX), CTX), []);
  const mctx = { taskId: 'FX-09', attempt: 1, reviewer: 'code-reviewer', criteriaIds: [], maintenance: true };
  assert.deepEqual(R.validateReview(R.reviewExample(mctx), mctx), []);
  const r = valid();
  delete r.notes;
  r.findings = [];
  r.findings.push({ severity: 'info', issue: 'Nice.', required_fix: 'None needed; keep as is.' });
  assert.deepEqual(R.validateReview(r, CTX), [], 'file/line/notes are optional; info severity is allowed');
});

test('pilot review-a1 (P1-AUDIO-02): text/fix/id/location keys are refused per path with hints', () => {
  // Shape of a real pilot review-a1.json written by an agent (abridged).
  const pilot = {
    ...valid(),
    findings: [
      { id: 'F1', severity: 'major', file: 'tests/unit/assets.test.ts', location: "describe('credits (AA-096)')", text: 'Silent skip.', fix: 'Golden string.' },
      { id: 'F2', severity: 'minor', file: 'tests/unit/assets.test.ts', text: 'Rename the test.' },
    ],
  };
  const p = R.validateReview(pilot, CTX);
  for (const msg of [
    'findings[0].text: unknown key; did you mean issue?',
    'findings[0].fix: unknown key; did you mean required_fix?',
    'findings[0].issue: required non-empty string',
    'findings[0].required_fix: required non-empty string',
    'findings[1].text: unknown key; did you mean issue?',
    'findings[1].required_fix: required non-empty string',
  ]) assert.ok(p.includes(msg), `expected "${msg}" in:\n${p.join('\n')}`);
  assert.ok(p.some((x) => x.startsWith('findings[0].id: unknown key; allowed: severity, file, line, issue, required_fix')));
  assert.ok(p.some((x) => x === 'findings[0].location: unknown key; did you mean line?'));
  assert.ok(p.length >= 9, 'every problem is listed at once');
});

test('pilot review-a2: APPROVE is refused with a hint; other verdict and severity aliases too', () => {
  const r = { ...valid(), verdict: 'APPROVE' };
  assert.deepEqual(R.validateReview(r, CTX), ['verdict: "APPROVE" is not allowed (ACCEPT|REJECT); did you mean ACCEPT?']);
  assert.match(R.validateReview({ ...valid(), verdict: 'accept' }, CTX)[0], /did you mean ACCEPT\?/);
  assert.match(R.validateReview({ ...valid(), verdict: 'CHANGES_REQUESTED' }, CTX)[0], /did you mean REJECT\?/);
  assert.match(R.validateReview({ ...valid(), verdict: undefined }, CTX)[0], /^verdict: missing is not allowed/);
  const sev = valid();
  sev.findings[0].severity = 'high';
  assert.deepEqual(R.validateReview(sev, CTX), ['findings[0].severity: "high" is not allowed (critical|major|minor|info); did you mean major?']);
});

test('the orchestrator mistake: `acceptance` instead of `criteria` is refused with a hint', () => {
  const r = /** @type {any} */ (valid());
  r.acceptance = r.criteria;
  delete r.criteria;
  const p = R.validateReview(r, CTX);
  assert.ok(p.includes('acceptance: unknown key; did you mean criteria?'), p.join('\n'));
  assert.ok(p.some((x) => x.startsWith('criteria: required array with one entry per acceptance id (AC1, AC2)')));
});

test('criteria: missing, extra, duplicate and malformed entries are refused with exact paths', () => {
  const missing = valid();
  missing.criteria = [missing.criteria[0]];
  assert.deepEqual(R.validateReview(missing, CTX), ['criteria: missing criterion AC2 (every acceptance id must be assessed exactly once)']);

  const extra = valid();
  extra.criteria.push({ id: 'AC9', met: true, evidence: 'x' });
  assert.deepEqual(R.validateReview(extra, CTX), ['criteria[2].id: unknown acceptance id "AC9" (expected AC1, AC2)']);

  const dup = valid();
  dup.criteria.push({ ...dup.criteria[0] });
  assert.deepEqual(R.validateReview(dup, CTX), ['criteria[2].id: duplicate AC1 (already assessed in criteria[0])']);

  const bad = /** @type {any} */ (valid());
  bad.criteria[0] = { id: 'AC1', status: 'met', proof: 'x' };
  const p = R.validateReview(bad, CTX);
  assert.ok(p.includes('criteria[0].status: unknown key; did you mean met?'), p.join('\n'));
  assert.ok(p.includes('criteria[0].proof: unknown key; did you mean evidence?'));
  assert.ok(p.includes('criteria[0].met: required boolean, got missing'));
  assert.ok(p.includes('criteria[0].evidence: required non-empty string'));
});

test('top level: context mismatches, unknown keys and wrong types are refused', () => {
  const r = /** @type {any} */ ({ ...valid(), taskId: 'P1-OTHER', attempt: 2, reviewer: 'code-reviewer', summary: ' ', extra: 1, notes: 5 });
  const p = R.validateReview(r, CTX);
  assert.deepEqual(p.sort(), [
    'attempt: 2 must equal the current attempt 1',
    'extra: unknown key; allowed: taskId, attempt, reviewer, verdict, summary, criteria, findings, notes',
    'notes: must be a string when present',
    'reviewer: "code-reviewer" must equal the assigned reviewer "tech-architect"',
    'summary: required non-empty string',
    'taskId: "P1-OTHER" must equal the task id "P1-AUDIO-02"',
  ].sort());
  assert.deepEqual(R.validateReview([], CTX), ['(root): the review must be a JSON object']);
  const f = valid();
  /** @type {any} */ (f.findings[0]).line = '40';
  assert.deepEqual(R.validateReview(f, CTX), ['findings[0].line: must be a positive integer when present, got "40"']);
  const nf = /** @type {any} */ (valid());
  delete nf.findings;
  assert.deepEqual(R.validateReview(nf, CTX), ['findings: required array (use [] when there are none)']);
  // A game review may not use the maintenance-only keys.
  assert.ok(R.validateReview({ ...valid(), head: 'abcdef1' }, CTX).includes('head: unknown key; allowed: taskId, attempt, reviewer, verdict, summary, criteria, findings, notes'));
});

test('maintenance profile: head required, legacy id accepted, criteria from the brief', () => {
  const m = { taskId: 'FX-09', attempt: 1, reviewer: 'code-reviewer', criteriaIds: [], maintenance: true };
  const base = { attempt: 1, reviewer: 'code-reviewer', verdict: 'ACCEPT', summary: 's', findings: [], testsRun: [{ command: 'node --test', result: 'pass' }] };
  assert.deepEqual(R.validateReview({ ...base, taskId: 'FX-09', head: 'abcdef1' }, m), [], 'criteria may be omitted without brief ids');
  assert.deepEqual(R.validateReview({ ...base, id: 'FX-09', head: 'abcdef1' }, m), [], 'legacy `id` of FX-00 packets');
  assert.deepEqual(R.validateReview({ ...base, id: 'FX-09', taskId: 'FX-09', head: 'abcdef1' }, m), ['id: use only taskId (id is its legacy alias for maintenance reviews)']);
  assert.deepEqual(R.validateReview({ ...base, taskId: 'FX-09' }, m), ['head: required sha of the reviewed commit (7-40 hex chars), got missing']);
  assert.deepEqual(R.validateReview({ ...base, taskId: 'FX-09', head: 'abcdef1', testsRun: [{ cmd: 'x', result: 'pass' }] }, m).sort(),
    ['testsRun[0].cmd: unknown key; allowed: name, command, result, detail', 'testsRun[0].command: required non-empty string'].sort());
  const withIds = { ...m, criteriaIds: ['AC1'] };
  assert.deepEqual(R.validateReview({ ...base, taskId: 'FX-09', head: 'abcdef1' }, withIds), ['criteria: required array with one entry per acceptance id (AC1)']);
  assert.deepEqual(R.validateReview({ ...base, taskId: 'FX-09', head: 'abcdef1', criteria: [{ id: 'AC1', met: true, evidence: 'e' }] }, withIds), []);

  assert.deepEqual(R.parseBriefAcceptanceIds('# FX-09\n\n## Required\n- **AC0** not here\n\n## Acceptance criteria\n- **AC1** one\n- `FX09-AC2` two\n- AC3: three\n- plain text\n\n### Detail\n- **AC4** nested\n\n## Definition of Done\n- **AC5** not here'),
    ['AC1', 'FX09-AC2', 'AC3', 'AC4']);
  assert.deepEqual(R.parseBriefAcceptanceIds('# FX-01\n## Required\n1. A module'), []);
});

test('formatFinding never prints undefined, including legacy (pilot) findings already in event logs', () => {
  assert.equal(R.formatFinding({ severity: 'major', file: 'a.ts', line: 3, issue: 'Bad.', required_fix: 'Fix.' }), '[major] a.ts:3 Bad. => required: Fix.');
  assert.equal(R.formatFinding({ severity: 'major', file: 'a.ts', text: 'Legacy.', fix: 'Legacy fix.' }), '[major] a.ts Legacy. => required: Legacy fix.');
  for (const f of [{}, { severity: 'minor', text: 'only text' }, null, 'x', { file: 'a', line: 'x' }]) {
    assert.doesNotMatch(R.formatFinding(f), /undefined|null/, JSON.stringify(f));
  }
});

test('code-reviewer.md: the inline example is exactly the module example; all reviewer agents point to the commands', () => {
  const agents = path.join(REAL_ROOT, '.claude', 'agents');
  const cr = fs.readFileSync(path.join(agents, 'code-reviewer.md'), 'utf8');
  const blocks = [...cr.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(blocks.length, 1, 'exactly one JSON example in code-reviewer.md');
  assert.deepEqual(blocks[0], R.reviewExample());
  for (const name of ['code-reviewer.md', 'qa-engineer.md', 'qa-engineer-retry.md', 'tech-architect.md']) {
    const text = fs.readFileSync(path.join(agents, name), 'utf8');
    assert.match(text, /factory\.mjs review schema/, `${name} points to review schema`);
    assert.match(text, /factory\.mjs review check/, `${name} requires review check`);
  }
  const skill = fs.readFileSync(path.join(REAL_ROOT, '.claude', 'skills', 'factory-dev-loop', 'SKILL.md'), 'utf8');
  assert.match(skill, /task review-packet <TASK>/);
});

// ---------------------------------------------------------------- end to end

function human(prompt) {
  const r = spawnSync(process.execPath, [`${HOOKS}/user-prompt.mjs`], { input: JSON.stringify({ prompt, session_id: 'fx01' }), env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function agentWrite(file, content, who = {}) {
  const r = decide({ tool_name: 'Write', agent_id: who.id, agent_type: who.type, tool_input: { file_path: file }, cwd: TMP });
  assert.equal(r.decision, null, `write denied: ${r.reason}`);
  applyEffects(r.effects);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
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
const inbox = (n, kind) => `${paths().inbox}/${GAME}/R1/${kind}-a${n}.json`;
function report(n, who) {
  agentWrite(inbox(n, 'report'), { taskId: 'R1', attempt: n, agent: who.type, summary: 'done', filesChanged: [], testsRun: [], acceptance: ['AC1', 'AC2'].map((id) => ({ id, status: 'met', evidence: 't' })), knownLimitations: [], unresolvedDefects: [] }, who);
}
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env }, encoding: 'utf8' });
const dev = { id: 'dev1', type: 'game-developer' };
const devRetry = { id: 'dev1', type: 'game-developer-retry' };
const rev = { id: 'rev1', type: 'code-reviewer' };
const reviewOf = (n, over = {}) => ({
  taskId: 'R1', attempt: n, reviewer: 'code-reviewer', verdict: 'REJECT', summary: `attempt ${n} rejected`,
  criteria: [{ id: 'AC1', met: true, evidence: 'src/r/r.js exports r' }, { id: 'AC2', met: false, evidence: 'no unit test asserts the value' }],
  findings: [{ severity: 'major', file: 'src/r/r.js', line: 1, issue: `Attempt ${n}: value is not covered by a test.`, required_fix: `Attempt ${n}: add a unit test asserting r.` }],
  ...over,
});

test('e2e: review packet, strict task review, review check, retry packet and blocker show real findings', () => {
  // Game in DEVELOPMENT with one task (gates via the real UserPromptSubmit hook, like lifecycle.test.mjs).
  G.newGame(GAME, 'Review Game');
  const repo = T.gameRepo(GAME);
  const designer = { id: 'd1', type: 'game-designer' };
  agentWrite(`${repo}/design/concept/concept-brief.md`, '# Concept', designer);
  human("/approve-concept");
  G.approveConcept(GAME);
  G.startSpec(GAME);
  for (const f of G.REQUIRED_SPEC_DOCS) agentWrite(`${repo}/design/spec/${f}`, `# ${f}`, designer);
  human("/approve-spec");
  G.approveSpec(GAME);
  human("/start-development");
  G.startDevelopment(GAME, { template: 'mini' });
  const plan = {
    phases: [{ n: 1, name: 'Only', goal: 'r', exitCriteria: ['unit suite exits 0'] }],
    tasks: [{
      id: 'R1', phase: 1, title: 'Task R1', description: 'Implement R1 exactly as described in the specification section.', agent: 'game-developer', reviewer: 'code-reviewer',
      deps: [], scope: ['src/r/**'], tests: ['unit'], risk: 'low',
      acceptance: [{ id: 'AC1', text: 'R1 module exports a value', check: 'review' }, { id: 'AC2', text: 'a unit test asserts the exported value', check: 'test', ref: 'tests/unit/r.test.js' }],
    }],
  };
  fs.writeFileSync(`${TMP}/plan.json`, JSON.stringify(plan));
  G.loadPlan(GAME, `${TMP}/plan.json`);

  // Attempt 1 -> verified.
  const wt = T.startTask(GAME, 'R1').worktree;
  claim('R1', dev);
  commitIn(wt, { 'src/r/r.js': 'export const r = 1;\n' }, 'feat(R1): r');
  report(1, dev);
  assert.equal(T.submitTask(GAME, 'R1').ok, true);

  // Review packet: everything the reviewer needs, the exact schema and the self-check command.
  const rp = T.writeReviewPacket(GAME, 'R1');
  assert.equal(rp.packet, `${paths().inbox}/${GAME}/R1/review-packet-a1.md`);
  assert.equal(rp.dispatchTo, 'code-reviewer');
  const packet = fs.readFileSync(rp.packet, 'utf8');
  for (const s of ['Attempt: 1', 'Implementer (this attempt): game-developer', `git diff develop...task/R1`, '/evidence/R1/a1/verify.json',
    '**AC1**', '**AC2**', 'every acceptance id exactly once: AC1, AC2', `review check "${inbox(1, 'review')}" --task R1 --game ${GAME}`, inbox(1, 'review'), '"required_fix"']) {
    assert.ok(packet.includes(s), `review packet lacks ${s}`);
  }
  // Orchestrator-only command; review schema/check are allowed for subagents.
  const sub = (command) => decide({ tool_name: 'Bash', agent_id: 'rev1', agent_type: 'code-reviewer', tool_input: { command } }).decision;
  assert.equal(sub(`node factory/cli/factory.mjs task review-packet R1 --game ${GAME}`), 'deny');
  assert.equal(sub('node factory/cli/factory.mjs review schema'), null);
  assert.equal(sub(`node factory/cli/factory.mjs review check ${inbox(1, 'review')} --task R1 --game ${GAME}`), null);

  // A pilot-style review is refused with every problem listed; nothing is recorded.
  agentWrite(inbox(1, 'review'), {
    taskId: 'R1', attempt: 1, reviewer: 'code-reviewer', verdict: 'APPROVE', summary: 's',
    acceptance: [{ id: 'AC1', met: true, evidence: 'e' }], findings: [{ severity: 'minor', text: 't', fix: 'f' }],
  }, rev);
  const before = S.loadState(GAME).tasks.R1.status;
  assert.throws(() => T.recordReview(GAME, 'R1'), (e) => {
    for (const s of ['verdict: "APPROVE" is not allowed (ACCEPT|REJECT); did you mean ACCEPT?', 'acceptance: unknown key; did you mean criteria?',
      'findings[0].text: unknown key; did you mean issue?', 'findings[0].fix: unknown key; did you mean required_fix?', 'criteria: required array']) {
      assert.ok(e.message.includes(s), `missing "${s}" in ${e.message}`);
    }
    return true;
  });
  assert.equal(S.loadState(GAME).tasks.R1.status, before, 'an invalid review records nothing');

  // `review check` (CLI): invalid -> exit 1 with path-level problems (context inferred from the path).
  const bad = cli(['review', 'check', inbox(1, 'review')]);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /INVALID: .*review-a1\.json \(review-game R1 attempt 1\)/);
  assert.match(bad.stdout, /findings\[0\]\.text: unknown key; did you mean issue\?/);
  const schema = cli(['review', 'schema', '--task', 'R1', '--game', GAME]);
  assert.equal(schema.status, 0, schema.stderr);
  assert.match(schema.stdout, /every acceptance id exactly once: AC1, AC2/);

  // A valid REJECT: check says OK (explicit flags), then it is recorded.
  agentWrite(inbox(1, 'review'), reviewOf(1), rev);
  const ok = cli(['review', 'check', inbox(1, 'review'), '--task', 'R1', '--game', GAME]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^OK: /);
  assert.equal(S.loadState(GAME).tasks.R1.status, 'VERIFIED', 'review check records nothing');
  assert.equal(T.recordReview(GAME, 'R1').verdict, 'REJECT');

  // The retry packet carries the real issue / required_fix text.
  const a2 = T.startTask(GAME, 'R1');
  const p2 = fs.readFileSync(a2.packet, 'utf8');
  assert.ok(p2.includes('- [major] src/r/r.js:1 Attempt 1: value is not covered by a test. => required: Attempt 1: add a unit test asserting r.'), p2);
  assert.doesNotMatch(p2, /undefined/);

  // Attempts 2 and 3 rejected -> BLOCKED; the blocker report shows every finding in full.
  for (const n of [2, 3]) {
    if (n === 3) T.startTask(GAME, 'R1');
    claim('R1', devRetry);
    commitIn(wt, { 'src/r/r.js': `export const r = ${n};\n` }, `fix(R1): attempt ${n}`);
    report(n, devRetry);
    assert.equal(T.submitTask(GAME, 'R1').ok, true);
    agentWrite(inbox(n, 'review'), reviewOf(n), rev);
    const stale = cli(['review', 'check', inbox(n - 1, 'review'), '--task', 'R1', '--game', GAME]);
    assert.match(stale.stdout, new RegExp(`attempt: ${n - 1} must equal the current attempt ${n}`), 'an old review does not pass for the current attempt');
    T.recordReview(GAME, 'R1');
  }
  const s = S.loadState(GAME);
  assert.equal(s.tasks.R1.status, 'BLOCKED');
  const blocker = fs.readFileSync(s.tasks.R1.blocker, 'utf8');
  for (const n of [1, 2, 3]) assert.ok(blocker.includes(`[major] src/r/r.js:1 Attempt ${n}: value is not covered by a test. => required: Attempt ${n}: add a unit test asserting r.`), blocker);
  assert.doesNotMatch(blocker, /undefined/);
});
