// @ts-check
/**
 * FX-15: abandon a draft game (/abandon-game -> ABANDONED) and archive it (/archive-game from ABANDONED -> ARCHIVED).
 * Covered: abandon in every pre-development mode; refusals (later modes, no / foreign / reused token, no reason,
 * open change request, unfinished task, live claim) that never consume the token; archive of an abandoned draft
 * (archive dir with production records + design, game repo commit, ARCHIVED); archive regression for PACKAGED and
 * the refusal for IDEATION; replay determinism (with and without the new event); next actions per mode; the real
 * UserPromptSubmit hook (game selection, target, missing reason); guard (design frozen, archive/ message); the CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.resolve(HERE, '../../hooks');
const CLI = path.resolve(HERE, '../factory.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx15-'));
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 2, maxActiveAgents: 3, packageManager: 'corepack pnpm' }));

const { paths, git, readJson } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const A = await import('../lib/approvals.mjs');
const { nextActions, statusText, factoryOverview } = await import('../lib/reports.mjs');
const { recordClaim, updateAgentMap } = await import('../lib/claims.mjs');
const { decide } = await import('../lib/guard.mjs');

/** Simulate the human typing a slash command: runs the REAL UserPromptSubmit hook. */
function human(prompt) {
  const r = spawnSync(process.execPath, [`${HOOKS}/user-prompt.mjs`], { input: JSON.stringify({ prompt, session_id: 'fx15' }), env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}
const tokenFor = (command, game) => A.findToken({ command, game, target: command === 'abandon-game' ? `abandon:${game}` : `archive:${game}` });

/** Events that bring a fresh game (game.created only) into `mode`. */
const TO_MODE = {
  IDEATION: [],
  CONCEPT_APPROVED: [{ type: 'concept.approved', data: { hash: 'c' } }],
  SPEC_DRAFT: [{ type: 'concept.approved', data: { hash: 'c' } }, { type: 'spec.started' }],
  SPEC_APPROVED: [{ type: 'concept.approved', data: { hash: 'c' } }, { type: 'spec.started' }, { type: 'spec.approved', data: { hash: 's' } }],
};
const DEV = [...TO_MODE.SPEC_APPROVED, { type: 'dev.authorized', data: { hash: 's' } }];
const PLAN = { type: 'plan.loaded', data: { phases: [{ n: 1, name: 'P1', goal: 'g', exitCriteria: ['x'] }], tasks: [], baseHead: 'b' } };
const LATER = {
  DEV_AUTHORIZED: DEV,
  DEVELOPMENT: [...DEV, PLAN],
  RC_READY: [...DEV, PLAN, { type: 'phase.approved', data: { n: 1 } }],
  PACKAGED: [...DEV, PLAN, { type: 'phase.approved', data: { n: 1 } }, { type: 'release.approved', data: { version: '1.0.0', tag: 'v1.0.0', mainCommit: 'm' } },
    { type: 'release.packaged', data: { zip: 'z', sha256: 'h' } }],
};

/** Register a game with a real repo (G.newGame) and move it to `mode` with raw events. */
function draft(id, events = []) {
  G.newGame(id, `Game ${id}`);
  if (events.length) S.commit(id, events);
  return S.loadState(id);
}

test('abandon in every pre-development mode -> ABANDONED (reason + fromMode recorded, token consumed)', () => {
  for (const mode of S.PRE_DEV_MODES) {
    const id = `ab-${mode.toLowerCase().replace(/_/g, '-')}`;
    assert.equal(draft(id, TO_MODE[mode]).mode, mode);
    assert.match(human(`/abandon-game ${id} superseded by another idea`), /recorded and signed: \/abandon-game game=ab-/);
    const s = G.abandonGame(id, '  superseded by another idea ');
    assert.equal(s.mode, 'ABANDONED');
    assert.deepEqual({ reason: s.abandoned.reason, fromMode: s.abandoned.fromMode }, { reason: 'superseded by another idea', fromMode: mode });
    assert.equal(tokenFor('abandon-game', id), null, 'token consumed');
    const ev = S.loadEvents(id).at(-1);
    assert.equal(ev.type, 'game.abandoned');
    assert.equal(ev.actor, 'human');
  }
});

test('abandon is refused in DEV_AUTHORIZED and later (and when already ABANDONED / ARCHIVED); the token survives', () => {
  for (const [mode, events] of Object.entries(LATER)) {
    const id = `late-${mode.toLowerCase().replace(/_/g, '-')}`;
    assert.equal(draft(id, events).mode, mode);
    human(`/abandon-game ${id} no longer wanted`);
    assert.throws(() => G.abandonGame(id, 'no longer wanted'), new RegExp(`is in ${mode}; only a draft game`));
    assert.ok(tokenFor('abandon-game', id), `${mode}: refusal must not consume the token`);
  }
  const id = 'twice';
  draft(id);
  human(`/abandon-game ${id} first`);
  G.abandonGame(id, 'first');
  human(`/abandon-game ${id} second`);
  assert.throws(() => G.abandonGame(id, 'second'), (e) => /is in ABANDONED/.test(e.message) && e.hints.includes('User types /archive-game'));
});

test('abandon refuses: no token, a token for another game, a reused token, no reason, open change request, unfinished task, live claim', () => {
  draft('r-a');
  draft('r-b');
  assert.throws(() => G.abandonGame('r-a', 'why'), /No valid human approval for "\/abandon-game" on game r-a/);
  human('/abandon-game r-b other game token');
  assert.throws(() => G.abandonGame('r-a', 'why'), /No valid human approval/, 'a token for r-b does not abandon r-a');
  assert.ok(tokenFor('abandon-game', 'r-b'));
  // No reason: refused before the token is consumed.
  for (const bad of [undefined, true, '', '   ']) assert.throws(() => G.abandonGame('r-b', bad), /A reason is required/);
  assert.ok(tokenFor('abandon-game', 'r-b'), 'refusal without reason keeps the token');
  // Reused token.
  G.abandonGame('r-b', 'other game token');
  draft('r-c');
  assert.equal(tokenFor('abandon-game', 'r-c'), null);
  assert.throws(() => G.abandonGame('r-c', 'why'), /No valid human approval/);

  // Open change request.
  draft('r-cr', [...TO_MODE.SPEC_APPROVED, { type: 'change.requested', data: { text: 'add a level editor' } }]);
  human('/abandon-game r-cr dropped');
  assert.throws(() => G.abandonGame('r-cr', 'dropped'), /open change request \("add a level editor"\)/);
  assert.ok(tokenFor('abandon-game', 'r-cr'));

  // Unfinished task (defensive: tasks normally exist only from DEVELOPMENT on).
  draft('r-task', [{ type: 'plan.amended', data: { tasks: [{ id: 'T1', phase: 1, title: 't', deps: [], scope: [], agent: 'game-developer', reviewer: 'code-reviewer' }] } }]);
  human('/abandon-game r-task dropped');
  assert.throws(() => G.abandonGame('r-task', 'dropped'), /unfinished tasks: T1\(PENDING\)/);

  // Live claim of an agent on this game.
  draft('r-claim');
  recordClaim('agent-x', { agentType: 'game-designer', game: 'r-claim', task: 'T9', attempt: 1, claimedAt: new Date().toISOString() });
  human('/abandon-game r-claim dropped');
  assert.throws(() => G.abandonGame('r-claim', 'dropped'), (e) => /live claims: agent-x \(game-designer\) T9/.test(e.message) && e.hints.some((h) => /recover --apply/.test(h)));
  assert.ok(tokenFor('abandon-game', 'r-claim'));
  updateAgentMap((m) => { m.agents['agent-x'].active = false; });
  assert.equal(G.abandonGame('r-claim', 'dropped').mode, 'ABANDONED', 'after the claim ended the same token works');
});

test('archive from ABANDONED: archive dir with production records + design, game repo commit, ARCHIVED, nothing deleted', () => {
  const id = 'arch-draft';
  draft(id, TO_MODE.CONCEPT_APPROVED);
  const repo = `${paths().games}/${id}`;
  fs.writeFileSync(`${repo}/design/concept/concept-brief.md`, '# Brief\n');
  fs.writeFileSync(`${repo}/design/spec/gdd.md`, '# GDD draft (never committed)\n');
  human(`/abandon-game ${id} superseded`);
  const ab = G.abandonGame(id, 'superseded');
  // Pausing never holds back the archive of an abandoned draft.
  S.commit(id, [{ type: 'game.paused' }]);
  // Design is frozen once abandoned.
  const w = decide({ tool_name: 'Write', tool_input: { file_path: `${repo}/design/spec/gdd.md` } });
  assert.equal(w.decision, 'deny');
  assert.match(w.reason, /game abandoned/);

  human(`/archive-game ${id}`);
  const s = G.archiveGame(id);
  assert.equal(s.mode, 'ARCHIVED');
  const base = `${paths().archive}/${id}/abandoned-${ab.abandoned.ts.slice(0, 10).replace(/-/g, '')}`;
  assert.equal(s.archive.dir, `${base}/production`);
  assert.equal(s.archive.design, `${base}/design`);
  assert.equal(s.archive.fromMode, 'ABANDONED');
  assert.equal(s.archive.reason, 'superseded');
  const archivedEvents = fs.readFileSync(`${base}/production/events.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(archivedEvents.some((e) => e.type === 'game.abandoned'));
  assert.ok(fs.existsSync(`${base}/production/state.json`));
  assert.equal(fs.readFileSync(`${base}/design/concept/concept-brief.md`, 'utf8'), '# Brief\n');
  assert.ok(fs.existsSync(`${base}/design/spec/gdd.md`));
  // Game repo: production records and design committed, tree clean, history kept.
  assert.equal(git(['log', '-1', '--format=%s'], repo), 'chore: archive abandoned draft (production records + design)');
  assert.equal(s.archive.repoCommit, git(['rev-parse', 'HEAD'], repo));
  const tracked = git(['ls-files'], repo).split('\n');
  for (const f of ['production/events.jsonl', 'design/concept/concept-brief.md', 'design/spec/gdd.md']) assert.ok(tracked.includes(f), f);
  assert.equal(git(['status', '--porcelain'], repo), '');
  assert.ok(fs.existsSync(`${S.gameDir(id)}/events.jsonl`), 'factory state kept');
  assert.equal(tokenFor('archive-game', id), null);
  // ARCHIVED is terminal: no next actions, compact status, hidden in the brief overview unless focused.
  assert.deepEqual(nextActions(s), []);
  assert.equal(statusText(s), `GAME ${id} "Game ${id}" — mode ARCHIVED (PAUSED)`);
  S.setFocus('ab-ideation');
  assert.ok(!factoryOverview({ brief: true }).includes(`GAME ${id} `));
  assert.ok(factoryOverview({ brief: false }).includes(`GAME ${id} `));
  human(`/abandon-game ${id} again`);
  assert.throws(() => G.abandonGame(id, 'again'), /is in ARCHIVED/);
});

test('archive: PACKAGED still archives by version (regression); IDEATION and DEVELOPMENT are refused without consuming the token', () => {
  const id = 'arch-pkg';
  draft(id, LATER.PACKAGED);
  human(`/archive-game ${id}`);
  const s = G.archiveGame(id);
  assert.equal(s.mode, 'ARCHIVED');
  assert.equal(s.archive.dir, `${paths().archive}/${id}/1.0.0/production`);
  assert.equal(s.archive.fromMode, undefined);
  assert.ok(fs.existsSync(`${paths().archive}/${id}/1.0.0/production/events.jsonl`));
  assert.ok(!fs.existsSync(`${paths().archive}/${id}/1.0.0/design`), 'released games keep the previous layout');
  assert.equal(git(['log', '-1', '--format=%s'], `${paths().games}/${id}`), 'chore: archive production records');

  draft('arch-idea');
  human('/archive-game arch-idea');
  assert.throws(() => G.archiveGame('arch-idea'), (e) => /is in IDEATION; requires PACKAGED, PUBLICATION_PREPARED or ABANDONED/.test(e.message) &&
    e.hints.some((h) => h.includes('/abandon-game arch-idea <reason>')));
  assert.ok(tokenFor('archive-game', 'arch-idea'), 'refusal keeps the token');
  draft('arch-dev', LATER.DEVELOPMENT);
  human('/archive-game arch-dev');
  assert.throws(() => G.archiveGame('arch-dev'), /is in DEVELOPMENT; requires PACKAGED or PUBLICATION_PREPARED or ABANDONED/);
});

test('replay determinism: rebuild equals the snapshot; logs without the new event rebuild exactly as before', () => {
  for (const id of ['arch-draft', 'ab-spec-draft', 'arch-pkg']) {
    assert.deepEqual(S.rebuild(id), readJson(`${S.gameDir(id)}/state.json`), id);
  }
  // An "old" log (events of the pre-FX-15 vocabulary only) has no new keys and replays to the same state twice.
  const old = S.loadEvents('late-packaged');
  const replay = () => old.reduce((s, ev) => S.reduce(s, ev), S.initialState('late-packaged'));
  const a = replay();
  assert.deepEqual(a, replay());
  assert.equal('abandoned' in a, false);
  assert.deepEqual(a, readJson(`${S.gameDir('late-packaged')}/state.json`));
  assert.ok(S.MODES.includes('ABANDONED') && S.MODES.at(-2) === 'ARCHIVED', 'existing mode order unchanged, ABANDONED appended');
});

test('next actions: /abandon-game in pre-development modes only; ABANDONED lists /archive-game', () => {
  const has = (s, cmd) => nextActions(s).some((a) => a.who === 'human' && a.cmd === cmd);
  for (const mode of S.PRE_DEV_MODES) {
    const s = { ...S.initialState('x'), mode };
    assert.ok(has(s, '/abandon-game <reason>'), mode);
    assert.equal(nextActions(s).find((a) => a.cmd === '/abandon-game <reason>')?.why, 'drop this draft game');
    assert.ok(!has(s, '/archive-game'), mode);
  }
  for (const mode of Object.keys(LATER)) assert.ok(!has(S.loadState(`late-${mode.toLowerCase().replace(/_/g, '-')}`), '/abandon-game <reason>'), mode);
  const ab = { ...S.initialState('x'), mode: 'ABANDONED', abandoned: { reason: 'superseded', fromMode: 'IDEATION', ts: 't' } };
  assert.deepEqual(nextActions(ab).map((a) => a.cmd), ['/archive-game']);
  assert.match(statusText(ab), /\[human\] \/archive-game — abandoned draft \(superseded\)/);
  assert.match(statusText({ ...S.initialState('x'), title: 'X', mode: 'IDEATION' }), /\[human\] \/abandon-game <reason> — drop this draft game/);
});

test('hook: /abandon-game takes the game only from the first word, binds abandon:<id>, refuses a missing reason', () => {
  draft('h-focus');
  draft('h-other');
  S.setFocus('h-focus');
  // The reason names another registered game: the focused game is still the one abandoned.
  const note = human('/abandon-game superseded by h-other');
  assert.match(note, /\/abandon-game game=h-focus target=abandon:h-focus/);
  const rec = tokenFor('abandon-game', 'h-focus');
  assert.equal(rec?.args.text, 'superseded by h-other');
  assert.equal(rec?.args.game, undefined);
  assert.equal(tokenFor('abandon-game', 'h-other'), null);
  // First word names the game.
  assert.match(human('/abandon-game h-other dropped for h-focus'), /game=h-other target=abandon:h-other/);
  assert.equal(tokenFor('abandon-game', 'h-other')?.args.text, 'dropped for h-focus');
  // Missing reason: nothing recorded.
  const before = fs.readFileSync(paths().approvals, 'utf8');
  assert.match(human('/abandon-game'), /Missing reason: the approval was NOT recorded.*\/abandon-game h-focus <reason>/);
  assert.match(human('/abandon-game h-other'), /Missing reason/);
  assert.equal(fs.readFileSync(paths().approvals, 'utf8'), before);
  // parseCommand / computeTarget units.
  assert.deepEqual(A.parseCommand('/abandon-game a b', ['a', 'b']), { command: 'abandon-game', kind: 'gate', args: { game: 'a', text: 'b' } });
  assert.deepEqual(A.parseCommand('/abandon-game x b', ['a', 'b']), { command: 'abandon-game', kind: 'gate', args: { text: 'x b' } });
  assert.deepEqual(A.parseCommand('/archive-game x b', ['a', 'b']).args, { game: 'b', text: 'x' }, 'other commands unchanged');
  assert.equal(A.computeTarget('abandon-game', { id: 'g1' }, {}, ''), 'abandon:g1');
  assert.ok(Object.hasOwn(A.GATES, 'abandon-game'));
  assert.match(A.GATES['archive-game'].describe, /released or abandoned/);
});

test('guard: archive/ stays CLI-only and the refusal names both archive commands', () => {
  const r = decide({ tool_name: 'Write', tool_input: { file_path: `${paths().archive}/x/abandoned-20260101/production/events.jsonl` } });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /factory gate archive-game/);
  assert.match(r.reason, /factory gate abandon-game/);
});

test('CLI: gate abandon-game --reason, then gate archive-game; status shows ARCHIVED', () => {
  draft('cli-game', TO_MODE.SPEC_DRAFT);
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env }, encoding: 'utf8' });
  human('/abandon-game cli-game superseded by h-focus');
  const noReason = cli('gate', 'abandon-game', '--game', 'cli-game');
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.stdout + noReason.stderr, /A reason is required/);
  const ok = cli('gate', 'abandon-game', '--game', 'cli-game', '--reason', 'superseded by h-focus');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /abandon-game: OK -> ABANDONED/);
  assert.match(ok.stdout, /\[human\] \/archive-game/);
  human('/archive-game cli-game');
  const arch = cli('gate', 'archive-game', '--game', 'cli-game');
  assert.equal(arch.status, 0, arch.stdout + arch.stderr);
  assert.match(arch.stdout, /archive-game: OK -> ARCHIVED/);
  const st = cli('status', '--game', 'cli-game');
  assert.match(st.stdout, /GAME cli-game "Game cli-game" — mode ARCHIVED/);
  assert.match(cli('help').stdout, /gate abandon-game --reason "<text>"/);
  assert.match(cli('gate', 'nope', '--game', 'cli-game').stdout + cli('gate', 'nope', '--game', 'cli-game').stderr, /abandon-game/);
});
