// @ts-check
/**
 * FX-00 — factory maintenance worktrees.
 * A temp FACTORY repo (FACTORY_ROOT) with branch main: start -> claim -> writes allowed only in the worktree
 * and its inbox -> SubagentStop report check -> merge refused without/with invalid review, self-review,
 * stale head, dirty worktree, unsafe root checkout, failing verification -> merge --no-ff after ACCEPT.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../factory.mjs');
const HOOKS = path.resolve(HERE, '../../hooks');
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx00-'));
const ROOT = `${TMP}/root`;
const env = {
  FACTORY_ROOT: ROOT, FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
const VERIFY_SCRIPT = `${TMP}/verify-probe.mjs`;
fs.writeFileSync(VERIFY_SCRIPT, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(`${TMP}/verify-probe.json`)}, JSON.stringify({ cwd: process.cwd().replace(/\\\\/g, '/'), root: process.env.FACTORY_ROOT ?? null }));\n`);
const setVerify = (verify) => fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 2, maxActiveAgents: 3, packageManager: 'corepack pnpm', models: REAL_CFG.models, maintenance: { verify } }));
setVerify([`node "${VERIFY_SCRIPT}"`]);

// A minimal factory repository on branch main.
fs.mkdirSync(`${ROOT}/factory/cli/lib`, { recursive: true });
fs.writeFileSync(`${ROOT}/factory/cli/lib/x.mjs`, 'export const x = 1;\n');
fs.writeFileSync(`${ROOT}/README.md`, '# temp factory\n');
fs.writeFileSync(`${ROOT}/notes.txt`, 'notes\n');
fs.writeFileSync(`${ROOT}/.gitignore`, 'local/\n');
const g0 = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8' });
for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'fx-test'], ['config', 'user.email', 'fx@localhost.invalid'], ['add', '-A'], ['commit', '-q', '-m', 'chore: initial factory']]) assert.equal(g0(a).status, 0);

const { paths, git, norm } = await import('../lib/core.mjs');
const M = await import('../lib/maint.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');

const ID = 'FX-77';
const BRIEF = `${TMP}/inbox/_factory/${ID}/brief.md`;
fs.mkdirSync(path.dirname(BRIEF), { recursive: true });
fs.writeFileSync(BRIEF, '# Add module y\n\nAdd factory/cli/lib/y.mjs exporting y = 2, with a test.\n');
const arch = { id: 'arch1', type: 'tech-architect' };
const reviewer = { id: 'rev1', type: 'code-reviewer' };

const bash = (command, who) => decide({ tool_name: 'Bash', agent_id: who?.id, agent_type: who?.type, tool_input: { command } });
const write = (file, who) => decide({ tool_name: 'Write', agent_id: who?.id, agent_type: who?.type, tool_input: { file_path: file }, cwd: TMP });
function agentWrite(file, content, who) {
  const r = write(file, who);
  assert.equal(r.decision, null, `write denied: ${r.reason}`);
  applyEffects(r.effects);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const wt = () => M.maintWorktree(ID);
const branchHead = () => git(['rev-parse', `fx/${ID}`], ROOT);
function review(verdict, head, who = reviewer, findings = [], id = ID, idKey = 'id') {
  agentWrite(M.maintReview(id), JSON.stringify({ [idKey]: id, attempt: 1, reviewer: who.type, head, verdict, findings, testsRun: [], summary: 's' }), who);
}
function report(head, who = arch, id = ID) {
  agentWrite(M.maintReport(id), JSON.stringify({ id, attempt: 1, agent: who.type, branch: `fx/${id}`, head, summary: 'y', filesChanged: ['factory/cli/lib/y.mjs'], testsRun: [] }), who);
}
function stopHook(who) {
  const r = spawnSync(process.execPath, [`${HOOKS}/subagent.mjs`], { input: JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: who.id, agent_type: who.type }), env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('maint start: validates agent, reviewer and brief; creates worktree, branch, packet and event', () => {
  assert.throws(() => M.startMaint('fx-1', { agent: 'tech-architect', brief: BRIEF }), /must match/);
  assert.throws(() => M.startMaint(ID, { agent: 'code-reviewer', brief: BRIEF }), /implementer/);
  assert.throws(() => M.startMaint(ID, { agent: 'general-purpose', brief: BRIEF }), /implementer/);
  assert.throws(() => M.startMaint(ID, { agent: 'qa-engineer', reviewer: 'qa-engineer', brief: BRIEF }), /same base role/);
  assert.throws(() => M.startMaint(ID, { agent: 'qa-engineer-retry', reviewer: 'qa-engineer', brief: BRIEF }), /same base role/);
  assert.throws(() => M.startMaint(ID, { agent: 'tech-architect', brief: `${TMP}/missing.md` }), /--brief/);

  const r = M.startMaint(ID, { agent: 'tech-architect', reviewer: 'code-reviewer', brief: BRIEF });
  assert.equal(r.worktree, norm(`${TMP}/wt/_factory/${ID}`));
  assert.equal(r.branch, `fx/${ID}`);
  assert.equal(r.dispatchTo, 'tech-architect');
  assert.equal(r.base, git(['rev-parse', 'main'], ROOT));
  assert.ok(fs.existsSync(`${r.worktree}/factory/cli/lib/x.mjs`), 'worktree checked out from main');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], r.worktree), `fx/${ID}`);
  const packet = fs.readFileSync(r.packet, 'utf8');
  assert.equal(r.packet, `${paths().inbox}/_factory/${ID}/packet-a1.md`);
  assert.ok(packet.includes(`node "${paths().root}/factory/cli/factory.mjs" maint claim ${ID}`), 'claim command uses the root CLI absolute path');
  assert.ok(packet.includes('Add factory/cli/lib/y.mjs exporting y = 2'), 'brief embedded');
  assert.ok(packet.includes(M.maintReport(ID)) && packet.includes(M.maintReview(ID)));
  assert.match(packet, /Dispatch to: tech-architect \(/);
  const it = M.loadMaint()[ID];
  assert.equal(it.status, 'STARTED');
  assert.equal(it.title, 'Add module y');
  assert.equal(fs.readFileSync(`${paths().state}/maintenance.jsonl`, 'utf8').trim().split('\n').length, 1, 'append-only event log');
  assert.equal(JSON.parse(fs.readFileSync(`${paths().state}/maintenance.json`, 'utf8'))[ID].status, 'STARTED', 'derived snapshot');
  assert.throws(() => M.startMaint(ID, { agent: 'tech-architect', brief: BRIEF }), /already started/);
});

test('guard: maint start/merge are orchestrator-only; claim/list/show allowed; only the recorded agent type claims', () => {
  const cli = `node "${paths().root}/factory/cli/factory.mjs"`;
  assert.equal(bash(`${cli} maint start FX-78 --agent game-developer --brief x.md`, arch).decision, 'deny');
  assert.equal(bash(`${cli} maint merge ${ID}`, reviewer).decision, 'deny');
  assert.equal(bash(`${cli} maint list`, reviewer).decision, null);
  assert.equal(bash(`${cli} maint show ${ID}`, reviewer).decision, null);
  const wrong = bash(`${cli} maint claim ${ID}`, { id: 'dev1', type: 'game-developer' });
  assert.equal(wrong.decision, 'deny');
  assert.match(wrong.reason, /assigned to tech-architect/);
  const ok = bash(`${cli} maint claim ${ID}`, arch);
  assert.equal(ok.decision, null, ok.reason);
  applyEffects(ok.effects);
  assert.match(bash(`${cli} maint claim ${ID}`, { id: 'arch2', type: 'tech-architect' }).reason, /already claimed by active agent arch1/);
  assert.match(M.claimMaintInfo(ID), /Factory maintenance packet FX-77/);
});

test('claimed agent writes only in its worktree and inbox; git writes only inside the worktree', () => {
  assert.equal(write(`${wt()}/factory/cli/lib/y.mjs`, arch).decision, null);
  assert.equal(write(`${paths().inbox}/_factory/${ID}/notes.md`, arch).decision, null);
  assert.match(write(M.maintReview(ID), arch).reason, /Implementers cannot write review files/);
  assert.equal(write(`${ROOT}/factory/cli/lib/x.mjs`, arch).decision, 'deny', 'root checkout is not writable');
  assert.equal(write(`${paths().inbox}/_factory/FX-99/x.md`, arch).decision, 'deny', 'other maintenance inbox');
  assert.equal(write(`${paths().state}/maintenance.jsonl`, arch).decision, 'deny');
  assert.equal(write(`${wt()}/factory/cli/lib/y.mjs`, { id: 'dev9', type: 'game-developer' }).decision, 'deny', 'unclaimed agent');
  assert.equal(write(`${wt()}/factory/cli/lib/y.mjs`, undefined).decision, 'deny', 'orchestrator does not write in worktrees');
  assert.equal(bash('git commit -am "feat(FX-77): y"', arch).decision, 'deny', 'git write without cd into the worktree');
  assert.equal(bash(`cd "${ROOT}" && git commit -am x`, arch).decision, 'deny', 'git write in the factory checkout');
  assert.equal(bash(`cd "${wt()}" && git add -A && git commit -m "feat(FX-77): y"`, arch).decision, null);
  assert.equal(bash(`cd "${wt()}" && git merge main`, arch).decision, null, 'merging main into the fx branch is allowed');
  assert.equal(bash(`cd "${wt()}" && git checkout main`, arch).decision, 'deny', 'stays on its branch');
  assert.equal(bash(`cd "${wt()}" && git diff $(git merge-base main HEAD)..HEAD && git log main..HEAD --oneline`, reviewer).decision, null, 'read-only git for reviewers');
});

test('SubagentStop blocks the maintenance implementer until report-a1.json exists', () => {
  const out = stopHook(arch);
  assert.match(out, /"decision":"block"/);
  assert.ok(out.includes('report-a1.json'));
});

test('merge refuses every unsafe state, then merges --no-ff after an independent ACCEPT of the branch head', () => {
  fs.writeFileSync(`${wt()}/factory/cli/lib/y.mjs`, 'export const y = 2;\n');
  fs.mkdirSync(`${wt()}/local`, { recursive: true });
  fs.writeFileSync(`${wt()}/local/cfg.json`, '{}\n');
  git(['add', '-A'], wt());
  git(['add', '-f', 'local/cfg.json'], wt()); // a path that is gitignored in the root checkout
  git(['commit', '-q', '-m', 'feat(FX-77): add y'], wt());
  assert.throws(() => M.mergeMaint(ID), /No report/);
  report('0000000');
  assert.equal(stopHook(arch), '', 'report present: the implementer may stop');
  assert.throws(() => M.mergeMaint(ID), /No independent review/);
  review('ACCEPT', branchHead());
  assert.throws(() => M.mergeMaint(ID), /report-a1\.json describes 0000000/, 'report must describe the branch head');
  report(branchHead());

  // Reviews from the wrong authors.
  agentWrite(M.maintReview(ID), JSON.stringify({ id: ID, head: branchHead(), verdict: 'ACCEPT', findings: [] }), {});
  assert.throws(() => M.mergeMaint(ID), /only code-reviewer may author/, 'orchestrator-written review');
  review('ACCEPT', branchHead(), { id: 'arch2', type: 'tech-architect' });
  assert.throws(() => M.mergeMaint(ID), /only code-reviewer may author/, 'review by the implementer type');

  // Review content.
  review('REJECT', branchHead());
  assert.throws(() => M.mergeMaint(ID), /verdict is REJECT/);
  review('ACCEPT', branchHead(), reviewer, [{ severity: 'major', file: 'factory/cli/lib/y.mjs', issue: 'i', required_fix: 'f' }]);
  assert.throws(() => M.mergeMaint(ID), /critical\/major/);
  review('ACCEPT', 'deadbeef');
  assert.throws(() => M.mergeMaint(ID), /review covers deadbeef/);
  review('ACCEPT', branchHead());

  // Worktree and root checkout safety.
  fs.writeFileSync(`${wt()}/scratch.txt`, 'x');
  assert.throws(() => M.mergeMaint(ID), /uncommitted or untracked/);
  fs.rmSync(`${wt()}/scratch.txt`);
  fs.writeFileSync(`${ROOT}/README.md`, '# staged change\n');
  git(['add', 'README.md'], ROOT);
  assert.throws(() => M.mergeMaint(ID), /staged changes/);
  git(['reset', '-q', 'README.md'], ROOT);
  git(['checkout', '--', 'README.md'], ROOT);
  fs.writeFileSync(`${ROOT}/factory/cli/lib/y.mjs`, 'local work');
  assert.throws(() => M.mergeMaint(ID), /would be overwritten.*factory\/cli\/lib\/y\.mjs/);
  fs.rmSync(`${ROOT}/factory/cli/lib/y.mjs`);
  fs.mkdirSync(`${ROOT}/local`, { recursive: true });
  fs.writeFileSync(`${ROOT}/local/cfg.json`, '{"secret":"local"}');
  assert.equal(git(['status', '--porcelain'], ROOT), '', 'the local file is ignored (invisible to git status)');
  assert.throws(() => M.mergeMaint(ID), /would be overwritten.*local\/cfg\.json/, 'ignored local file at a path the branch adds');
  fs.rmSync(`${ROOT}/local`, { recursive: true });

  // main moved: the branch must contain main, and the review must cover the new head.
  fs.writeFileSync(`${ROOT}/notes.txt`, 'notes v2\n');
  git(['commit', '-q', '-am', 'docs: unrelated change on main'], ROOT);
  assert.throws(() => M.mergeMaint(ID), /does not contain the current main/);
  git(['merge', '-q', '--no-edit', 'main'], wt());
  assert.throws(() => M.mergeMaint(ID), /review covers/);
  review('ACCEPT', branchHead(), reviewer, [], ID, 'taskId'); // `taskId` accepted as an alias of `id`
  assert.throws(() => M.mergeMaint(ID), /report-a1\.json describes/, 'the rework round needs a fresh report');
  report(branchHead());

  // Verification is re-run by the CLI; a failure merges nothing.
  const mainBefore = git(['rev-parse', 'main'], ROOT);
  setVerify(['node -e "process.exit(3)"']);
  assert.throws(() => M.mergeMaint(ID), /Verification failed.*exited 3/);
  assert.equal(git(['rev-parse', 'main'], ROOT), mainBefore, 'nothing merged');
  assert.equal(M.loadMaint()[ID].verifyFailures.length, 1);
  setVerify([`node "${VERIFY_SCRIPT}"`]);

  const r = M.mergeMaint(ID);
  assert.equal(r.merged, true);
  const probe = JSON.parse(fs.readFileSync(`${TMP}/verify-probe.json`, 'utf8'));
  assert.equal(probe.cwd.toLowerCase(), wt().toLowerCase(), 'verification ran in the worktree');
  assert.ok(!probe.root, 'FACTORY_* overrides do not leak into the verification run (cleared to an empty value)');
  assert.equal(git(['rev-parse', 'HEAD'], ROOT), r.merge);
  assert.equal(git(['log', '-1', '--format=%P'], ROOT).split(' ').length, 2, 'no-ff merge commit');
  assert.equal(git(['log', '-1', '--format=%s'], ROOT), `merge(${ID}): Add module y`);
  assert.match(git(['log', '-1', '--format=%b'], ROOT), /Independent review: code-reviewer ACCEPT/);
  assert.equal(fs.readFileSync(`${ROOT}/factory/cli/lib/y.mjs`, 'utf8').replace(/\r\n/g, '\n'), 'export const y = 2;\n', 'merged content in the root checkout (core.autocrlf may apply)');
  const it = M.loadMaint()[ID];
  assert.equal(it.status, 'MERGED');
  assert.equal(it.merge, r.merge);
  assert.ok(fs.existsSync(it.evidence), 'verification evidence kept');
  assert.throws(() => M.mergeMaint(ID), /already merged/);
  assert.match(bash(`node "${paths().root}/factory/cli/factory.mjs" maint claim ${ID}`, arch).reason, /MERGED/);
  assert.match(M.showMaint(ID).next, /^done/);
});

test('CLI wiring: maint start/list/show', () => {
  const brief = `${TMP}/inbox/_factory/FX-78/brief.md`;
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, '# Second change\n\nDetails.\n');
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });
  const s = cli('maint', 'start', 'FX-78', '--agent', 'platform-engineer', '--brief', brief);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /Dispatch to: platform-engineer \(.*claude-sonnet-5-5/);
  const l = cli('maint', 'list');
  assert.match(l.stdout, /FX-77\tMERGED/);
  assert.match(l.stdout, /FX-78\tSTARTED\tplatform-engineer -> code-reviewer/);
  const sh = JSON.parse(cli('maint', 'show', 'FX-78', '--json').stdout);
  assert.equal(sh.facts.reportWritten, false);
  assert.match(sh.next, /dispatch platform-engineer/);
  assert.equal(cli('maint', 'merge', 'FX-78').status, 1, 'no report, no merge');
});

test('guard (game task claim): git writes are judged by the effective directory, read-only git stays free', () => {
  const GWT = norm(`${paths().worktrees}/g1/T1`);
  const dev = { id: 'gdev1', type: 'game-developer' };
  applyEffects([{ type: 'claim', agentId: dev.id, rec: { game: 'g1', task: 'T1', worktree: GWT, attempt: 1, agentType: dev.type, claimedAt: new Date().toISOString() } }]);
  const sh = (command, who, cwd) => decide({ tool_name: 'Bash', agent_id: who.id, agent_type: who.type, tool_input: { command }, cwd }).decision;
  // Implementer inside its worktree.
  assert.equal(sh(`cd "${GWT}" && git add -A && git commit -m "feat(T1): x"`, dev), null, 'absolute cd');
  assert.equal(sh('git commit -m "feat(T1): x"', dev, GWT), null, 'bare commit with cwd = worktree');
  assert.equal(sh(`cd ${path.relative(ROOT, GWT).replace(/\\/g, '/')} && git commit -m x`, dev, ROOT), null, 'relative cd from the root');
  assert.equal(sh(`cd "${GWT}" && cd src && git add -A`, dev), null, 'nested cd stays inside');
  assert.equal(sh(`git -C "${GWT}" -c user.name=x commit -m x`, dev), null, 'git -C with global options');
  assert.equal(sh(`cd "${GWT}" && git stash && git stash pop`, dev), null);
  // Implementer outside its worktree.
  assert.equal(sh(`git commit -m "see ${GWT}"`, dev, ROOT), 'deny', 'commit message naming the worktree from the root');
  assert.equal(sh(`cd "${GWT}1" && git commit -m x`, dev), 'deny', 'prefix worktree (T1 vs T11)');
  assert.equal(sh('git stash', dev, ROOT), 'deny', 'git stash in the root');
  assert.equal(sh('git add -A', dev, ROOT), 'deny', 'git add in the root');
  assert.equal(sh(`cd "${GWT}" && cd .. && git commit -m x`, dev), 'deny', 'cd .. leaves the worktree');
  assert.equal(sh('cd $HOME/x && git commit -m x', dev, GWT), 'deny', 'unresolvable target');
  assert.equal(sh(`git -C .. commit -m x`, dev, GWT), 'deny', '-C resolved against the current dir');
  assert.equal(sh(`(cd "${ROOT}" && git commit -m x)`, dev, GWT), 'deny', 'subshell');
  // Reviewers (no claim): read-only git with any path names.
  const rev = { id: 'grev1', type: 'code-reviewer' };
  for (const c of [
    `cd "${GWT}" && git diff develop...HEAD -- src/save/reset-progress.ts`,
    `cd "${GWT}" && git show HEAD:src/iap/restore.ts`,
    `cd "${GWT}" && git diff develop..HEAD -- src/ui/checkout.ts`,
    `cd "${GWT}" && git log --grep revert --format="%H commit %s"`,
    `cd "${GWT}" && git diff $(git merge-base develop HEAD)..HEAD && git status`,
  ]) assert.equal(sh(c, rev), null, c);
  const revWrite = decide({ tool_name: 'Bash', agent_id: rev.id, agent_type: rev.type, tool_input: { command: `cd "${GWT}" && git commit -m x` } });
  assert.equal(revWrite.decision, 'deny');
  assert.match(revWrite.reason, /Only an implementer with a claimed worktree/);
});

test('recovery: unrecorded fx worktree, branch merged but not recorded (reconciled by maint merge), unreadable log', async () => {
  const { recover } = await import('../lib/reports.mjs');
  fs.mkdirSync(`${paths().worktrees}/_factory/FX-99`, { recursive: true });
  assert.ok(M.maintFindings().some((f) => f.kind === 'maint-unrecorded' && f.task === 'FX-99'));
  fs.rmSync(`${paths().worktrees}/_factory/FX-99`, { recursive: true });

  // FX-78 (started by the CLI test): work, report, review, then a merge that was never recorded (crash).
  const W = M.maintWorktree('FX-78');
  const pe = { id: 'pe1', type: 'platform-engineer' };
  const c = bash(`node "${paths().root}/factory/cli/factory.mjs" maint claim FX-78`, pe);
  assert.equal(c.decision, null, c.reason);
  applyEffects(c.effects);
  fs.writeFileSync(`${W}/z.txt`, 'z\n');
  git(['add', '-A'], W);
  git(['commit', '-q', '-m', 'feat(FX-78): z'], W);
  const head = git(['rev-parse', 'HEAD'], W);
  assert.deepEqual(M.maintFindings().filter((f) => f.task === 'FX-78'), [], 'unmerged work is not a finding');
  report(head, pe, 'FX-78');
  review('ACCEPT', head, reviewer, [], 'FX-78');
  git(['merge', '--no-ff', '-q', '-m', 'merge(FX-78): Second change', 'fx/FX-78'], ROOT);
  const merge = git(['rev-parse', 'HEAD'], ROOT);
  assert.ok(M.maintFindings().some((f) => f.kind === 'maint-merged-unrecorded' && f.task === 'FX-78'));
  assert.ok(recover().every((f) => f.kind !== 'maint-merged-unrecorded'), 'game recover() is unchanged; the CLI and SessionStart append maintFindings()');
  assert.match(M.showMaint('FX-78').next, /already merged into main but not recorded/);
  const r = M.mergeMaint('FX-78');
  assert.equal(r.reconciled, true);
  assert.equal(r.merge, merge);
  assert.equal(M.loadMaint()['FX-78'].status, 'MERGED');
  assert.deepEqual(M.maintFindings(), []);

  // An unreadable maintenance log does not hide the rest of the SessionStart context.
  const bad = `${TMP}/bad-state`;
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(`${bad}/maintenance.jsonl`, '{"seq":1,"type":"bogus","data":{}}\n');
  const h = spawnSync(process.execPath, [`${HOOKS}/session-start.mjs`], { input: '{"source":"startup"}', env: { ...process.env, FACTORY_STATE_DIR: bad }, encoding: 'utf8' });
  const ctx = JSON.parse(h.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Factory: no games registered/);
  assert.match(ctx, /Maintenance log unreadable/);
});

test.after(() => {
  if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP}`);
});
