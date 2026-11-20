// @ts-check
/**
 * FX-05 — spec-mode writes for playbook owners (FD-01) and a precise shell guard (FD-04), plus the FX-00 / FX-01
 * review minors: git --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE, global options with values, read-only
 * stash list/show and clean -n, "reconciled (unverified)" maintenance merges, review-file attempt notes.
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
const HOOKS = path.resolve(HERE, '../../hooks');
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx05-'));
const ROOT = `${TMP}/root`;
const env = {
  FACTORY_ROOT: ROOT, FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_TEMPLATES_DIR: `${FIX}/templates`, FACTORY_KIT_DIR: `${FIX}/kit`, FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 2, maxActiveAgents: 3, packageManager: 'corepack pnpm', models: REAL_CFG.models, maintenance: { verify: ['node -e "process.exit(0)"'] } }));

// A minimal factory repository on branch main (for the maintenance cases).
fs.mkdirSync(`${ROOT}/factory/cli`, { recursive: true });
fs.writeFileSync(`${ROOT}/README.md`, '# temp factory\n');
const g0 = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8' });
for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'fx-test'], ['config', 'user.email', 'fx@localhost.invalid'], ['add', '-A'], ['commit', '-q', '-m', 'chore: initial factory']]) assert.equal(g0(a).status, 0);

const { paths, git, norm } = await import('../lib/core.mjs');
const G = await import('../lib/game.mjs');
const M = await import('../lib/maint.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');
const { checkReviewFile } = await import('../lib/review-check.mjs');
const { parseShell } = await import('../lib/shell.mjs');
const { shellCommands, writeTargets, cliInvocation, gitInfo } = await import('../lib/shell-rules.mjs');

const GAME = 'spec-game';
const CLI = `node "${ROOT}/factory/cli/factory.mjs"`;
const INBOX = paths().inbox;
const STATE = paths().state;

function human(prompt) {
  const r = spawnSync(process.execPath, [`${HOOKS}/user-prompt.mjs`], { input: JSON.stringify({ prompt, session_id: 'test' }), env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const write = (file, who) => decide({ tool_name: 'Write', agent_id: who?.id, agent_type: who?.type, tool_input: { file_path: file }, cwd: TMP });
function agentWrite(file, content, who) {
  const r = write(file, who);
  assert.equal(r.decision, null, `write denied: ${r.reason}`);
  applyEffects(r.effects);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
/** @param {string} command @param {{id?: string, type?: string}} [who] @param {string} [cwd] @param {string} [tool] */
const sh = (command, who, cwd, tool = 'Bash') => decide({ tool_name: tool, agent_id: who?.id, agent_type: who?.type, tool_input: { command }, cwd });
const ps = (command, who, cwd) => sh(command, who, cwd, 'PowerShell');

const designer = { id: 'gd1', type: 'game-designer' };
const asset = { id: 'ap1', type: 'asset-producer' };
const assetRetry = { id: 'ap2', type: 'asset-producer-retry' };
const qa = { id: 'qa1', type: 'qa-engineer' };
const qaRetry = { id: 'qa2', type: 'qa-engineer-retry' };
const dev = { id: 'dev1', type: 'game-developer' };
const rev = { id: 'rev1', type: 'code-reviewer' };
const spec = (f) => `${paths().games}/${GAME}/design/spec/${f}`;

// ---------------------------------------------------------------- FD-01

test('FD-01: asset-producer and qa-engineer write their own spec files in spec mode without a claim, nothing else', () => {
  G.newGame(GAME, 'Spec Game');
  const repo = `${paths().games}/${GAME}`;
  // IDEATION: the spec is not started yet.
  assert.match(write(spec('art-audio.md'), asset).reason, /not started/);
  agentWrite(`${repo}/design/concept/concept-brief.md`, '# Concept', designer);
  human('/approve-concept');
  assert.equal(G.approveConcept(GAME).mode, 'CONCEPT_APPROVED');

  for (const mode of ['CONCEPT_APPROVED', 'SPEC_DRAFT']) {
    if (mode === 'SPEC_DRAFT') G.startSpec(GAME);
    assert.equal(write(spec('art-audio.md'), asset).decision, null, `${mode}: asset-producer -> art-audio.md`);
    assert.equal(write(spec('art-audio.md'), assetRetry).decision, null, `${mode}: retry variant via base role`);
    assert.equal(write(spec('test-plan.md'), qa).decision, null, `${mode}: qa-engineer -> test-plan.md`);
    assert.equal(write(spec('test-plan.md'), qaRetry).decision, null, `${mode}: retry variant via base role`);
    // Only the files the playbook assigns.
    assert.match(write(spec('gdd.md'), asset).reason, /writes only design\/spec\/art-audio\.md/);
    assert.match(write(spec('art-audio.md'), qa).reason, /writes only design\/spec\/test-plan\.md/);
    assert.equal(write(spec('tech-design.md'), qa).decision, 'deny');
    assert.equal(write(`${repo}/design/concept/concept-brief.md`, asset).decision, 'deny', 'concept is not theirs');
    assert.equal(write(`${repo}/design/tech/notes.md`, qa).decision, 'deny', 'tech area is not theirs');
    assert.equal(write(`${repo}/src/main.ts`, asset).decision, 'deny', 'code needs a task');
    // Other implementers still need a claim.
    assert.match(write(spec('art-audio.md'), dev).reason, /No task claimed/);
  }

  for (const f of G.REQUIRED_SPEC_DOCS) agentWrite(spec(f), `# ${f}`, f === 'art-audio.md' ? asset : f === 'test-plan.md' ? qa : designer);
  human('/approve-spec');
  assert.equal(G.approveSpec(GAME).mode, 'SPEC_APPROVED');
  assert.match(write(spec('art-audio.md'), asset).reason, /Spec write refused: .*approved\/frozen/);
  assert.match(write(spec('test-plan.md'), qaRetry).reason, /Spec write refused/);

  // An open change request re-opens exactly their files.
  G.openChangeRequest(GAME, 'more levels');
  assert.equal(write(spec('art-audio.md'), asset).decision, null, 'change request: art-audio.md');
  assert.equal(write(spec('test-plan.md'), qa).decision, null, 'change request: test-plan.md');
  assert.equal(write(spec('gdd.md'), qa).decision, 'deny');
});

// ---------------------------------------------------------------- FD-04 lexer

test('lexer: no split inside quotes or heredoc bodies; substitutions are commands; redirections are separate', () => {
  const cmds = (s, o) => parseShell(s, o).filter((e) => e.kind === 'cmd').map((e) => /** @type {any} */ (e).words.map((w) => w.v).join(' '));
  assert.deepEqual(cmds('echo "a; b && c | d" && ls'), ['echo a; b && c | d', 'ls']);
  assert.deepEqual(cmds("echo 'x > .inbox/y' ; pwd"), ['echo x > .inbox/y', 'pwd']);
  const hd = "git commit -m \"$(cat <<'EOF'\nfix: start|claim|list; rm -rf .factory/x > .inbox/y\nEOF\n)\" && git log -1";
  assert.deepEqual(cmds(hd), ['cat', 'git commit -m $(…)', 'git log -1']);
  const hd2 = 'cat <<-END > out.txt\n\tline | with; separators\n\tEND\necho done';
  const e2 = parseShell(hd2).filter((e) => e.kind === 'cmd');
  assert.equal(e2.length, 2);
  assert.equal(/** @type {any} */ (e2[0]).redirs[0].target.v, 'out.txt');
  const r = /** @type {any} */ (parseShell('node x.mjs 2>&1 >&2 2>/dev/null >> log.txt &> all.txt')[0]).redirs;
  assert.deepEqual(r.map((x) => [x.fd, x.op, x.target.v]), [['2', '>&', '1'], [null, '>&', '2'], ['2', '>', '/dev/null'], [null, '>>', 'log.txt'], [null, '&>', 'all.txt']]);
  assert.deepEqual(cmds("Write-Host 'a; b' ; Get-Content `\"x`\"", { dialect: 'powershell' }), ['Write-Host a; b', 'Get-Content "x"']);
  assert.deepEqual(cmds("$m = @'\nline; with | pipes\n'@\ngit status", { dialect: 'powershell' }), ['$m = line; with | pipes', 'git status']);
  assert.deepEqual(cmds('(cd a && make) || echo `date`'), ['cd a', 'make', 'date', 'echo $(…)']);
  // Directory tracking: a subshell / substitution cd does not leak out.
  const dirs = shellCommands(`cd "${TMP}/x" && (cd "${TMP}/y" && pwd) && pwd && echo $(cd "${TMP}/z") && pwd`, { cwd: TMP }).filter((c) => c.name === 'pwd').map((c) => c.dir);
  assert.deepEqual(dirs, [norm(`${TMP}/y`), norm(`${TMP}/x`), norm(`${TMP}/x`)]);
  // Helpers.
  assert.equal(cliInvocation(shellCommands('cat factory/cli/factory.mjs')[0]), null);
  assert.equal(cliInvocation(shellCommands('node "D:\\f\\factory\\cli\\factory.mjs" task show T1 2>&1')[0]), 'task show T1');
  assert.deepEqual(writeTargets(shellCommands('cp -r .inbox/a /tmp/b')[0]).map((w) => w.v), ['/tmp/b']);
  const gi = gitInfo(shellCommands('git -P -c a=b -C /w --namespace n --no-pager commit -m x')[0]);
  assert.equal(gi?.sub, 'commit');
  assert.deepEqual(gi?.C, ['/w']);
});

// ---------------------------------------------------------------- FD-04 shell write rule

test('FD-04: shell writes whose target is in .factory/ or .inbox/ are denied (true positives)', () => {
  const W = /Shell writes into \.factory\/ or \.inbox\//;
  const bashDeny = [
    'echo x > .inbox/g/T1/report-a1.json',
    `echo x >> "${INBOX}/g/T1/notes.md"`,
    'node x.mjs 1> .factory/x.json',
    'ls &> .inbox/out.txt',
    'cat a.txt | tee -a .inbox/g/x.md',
    'cp /tmp/x.json .inbox/g/T1/',
    'cp -t .inbox/g a b',
    'mv a.json .factory/b.json',
    'tar -xf pack.tar -C .inbox/g',
    'tar -czf .inbox/g/out.tgz src',
    'rsync -a build/ .inbox/g/build/',
    "sed -i 's/a/b/' .inbox/g/T1/report-a1.json",
    'mkdir -p .inbox/g/new',
    'touch .factory/x',
    'rm .inbox/g/T1/review-a1.json',
    "node -e \"require('fs').writeFileSync('.inbox/g/x.json', '{}')\"",
    `node -e "require('fs').appendFileSync(process.argv[1], 'x')" "${STATE}/events.jsonl"`,
    'bash -c "echo x > .inbox/a"',
    'echo $(echo y > .factory/a)',
    `cd "${INBOX}/g" && echo x > report.json`,
    "cat > .inbox/g/r.md <<'EOF'\nhello\nEOF",
    'ls | xargs -I{} cp {} .inbox/g/',
    "bash <<'EOF'\necho x > .inbox/a\nEOF",
    'sh -s <<< "touch .factory/x"',
    "node <<'EOF'\nrequire('fs').writeFileSync('.inbox/g/x.json', '{}')\nEOF",
    "python3 - <<'EOF'\nopen('.inbox/g/x.txt', 'w').write('y')\nEOF",
    'curl -o .inbox/g/x.zip https://example.invalid/x.zip',
    `echo x > ${STATE}/approvals.jsonl`,
  ];
  for (const c of bashDeny) {
    const r = sh(c, rev);
    assert.equal(r.decision, 'deny', `expected deny: ${c}`);
    assert.match(r.reason, W, c);
    assert.equal(sh(c).decision, 'deny', `orchestrator too: ${c}`);
  }
  for (const c of [
    'Set-Content -Path .inbox\\g\\x.md -Value "y"',
    'Add-Content .factory\\x.json "y"',
    '"x" | Out-File -FilePath .inbox\\g\\x.md',
    'Copy-Item a.json -Destination .inbox\\g\\a.json',
    'Move-Item a.json .factory\\a.json',
    'New-Item .inbox\\g\\x.md -ItemType File',
    'Get-Content a | Tee-Object -FilePath .inbox\\g\\t.txt',
    'Write-Output x > .inbox\\g\\x.txt',
    'powershell -Command "Set-Content .inbox\\a.txt y"',
  ]) {
    const r = ps(c, rev);
    assert.equal(r.decision, 'deny', `expected deny (PowerShell): ${c}`);
    assert.match(r.reason, W, c);
  }
});

test('FD-04: reads, copies out, fd redirections and quoted text are not writes (false positives)', () => {
  const allow = [
    `${CLI} review check "${INBOX}/_factory/FX-05/review-a1.json" --task FX-05 --game _factory 2>&1 | head -20`,
    `${CLI} review check ${INBOX}/g/T1/review-a1.json --task T1 --game g 2>/dev/null`,
    `${CLI} status >&2`,
    'ls .inbox/g 2>/dev/null',
    'cat .factory/games/g/state.json 2>&1 | head',
    'grep -n verdict .inbox/g/T1/review-a1.json > NUL',
    'cp .inbox/g/T1/report-a1.json /tmp/report.json',
    'tar -xf .inbox/g/pack.tar -C /tmp/out',
    'tar -tf .inbox/g/pack.tar',
    'echo "a > .inbox/x; touch .factory/y"',
    "echo 'cp x .inbox/y'",
    "cat <<'EOF' > /tmp/notes.txt\necho x > .inbox/a; touch .factory/b\nEOF",
    "node <<'EOF'\nconsole.log(require('fs').readFileSync('.inbox/g/x.json', 'utf8'))\nEOF",
    'diff .inbox/g/a.json .inbox/g/b.json',
    'wc -l .factory/hook-log.jsonl',
    `node -e "console.log(require('fs').readFileSync('.inbox/g/x.json','utf8'))"`,
    'cat factory/cli/factory.mjs',
    'grep -n "maint (claim|list|show)" factory/cli/factory.mjs factory/cli/lib/guard.mjs',
    'head -50 factory/cli/factory.mjs | tail -5',
    'git diff main...HEAD -- factory/cli/factory.mjs factory/cli/lib/guard.mjs',
    'git show HEAD:factory/cli/factory.mjs | grep -n review',
    'git log --oneline -- factory/cli/ .inbox/',
  ];
  for (const c of allow) assert.equal(sh(c, rev).decision, null, `expected allow: ${c} -> ${sh(c, rev).reason}`);
  // The orchestrator: plan load of an .inbox amendment with a redirect/pipe (FD-04 evidence).
  assert.equal(sh(`node factory/cli/factory.mjs plan load ${INBOX}/g/plan/amend.json --amend --game g 2>&1 | head`).decision, null);
  for (const c of [
    'Get-Content .inbox\\g\\x.md 2>$null',
    'Select-String -Path .factory\\hook-log.jsonl -Pattern deny | Select-Object -First 5',
    'Copy-Item .inbox\\g\\report-a1.json -Destination C:\\temp\\r.json',
    "Write-Host 'Set-Content .inbox\\x'",
  ]) assert.equal(ps(c, rev).decision, null, `expected allow (PowerShell): ${c}`);
});

// ---------------------------------------------------------------- FD-04 factory CLI detection

test('FD-04: only `node <...>factory/cli/factory.mjs <args>` runs the factory CLI', () => {
  for (const c of [
    'node factory/cli/factory.mjs task integrate T1 2>&1',
    `${CLI} gate approve-spec`,
    `node --no-warnings "${ROOT}/factory/cli/factory.mjs" maint merge FX-01`,
    `cd "${ROOT}/factory/cli" && node factory.mjs spec refreeze`,
    'bash -c "node factory/cli/factory.mjs task start T1"',
    'echo $(node factory/cli/factory.mjs plan load x.json)',
    'FOO=1 node factory/cli/factory.mjs task review T1',
    'node "D:\\x\\.worktrees\\_factory\\FX-05\\factory\\cli\\factory.mjs" maint start FX-09 --agent x',
  ]) assert.match(sh(c, rev).reason ?? '', /Only the orchestrator may run/, c);
  for (const c of [`${CLI} status`, `${CLI} review schema --task T1 --game g`, `${CLI} assets search --type sprite 2>&1 | head -5`]) {
    assert.equal(sh(c, rev).decision, null, c);
  }
  // A second invocation in the same line is checked too (the old regex looked at the first only).
  assert.equal(sh(`${CLI} status && ${CLI} gate approve-spec`, rev).decision, 'deny');
});

// ---------------------------------------------------------------- git rules (FX-00 minors)

test('git: --git-dir/--work-tree/GIT_DIR/GIT_WORK_TREE denied; globals with values skipped; stash list/show and clean -n read-only', () => {
  const WT = norm(`${paths().worktrees}/${GAME}/T1`);
  const impl = { id: 'gdev5', type: 'game-developer' };
  applyEffects([{ type: 'claim', agentId: impl.id, rec: { game: GAME, task: 'T1', worktree: WT, attempt: 1, agentType: impl.type, claimedAt: new Date().toISOString() } }]);
  const redirect = /may not use --git-dir, --work-tree, GIT_DIR or GIT_WORK_TREE/;
  for (const c of [
    `cd "${WT}" && git --git-dir="${ROOT}/.git" commit -m x`,
    `cd "${WT}" && git --git-dir "${ROOT}/.git" commit -m x`,
    `cd "${WT}" && git --work-tree "${ROOT}" add -A`,
    `cd "${WT}" && GIT_DIR="${ROOT}/.git" git commit -m x`,
    `cd "${WT}" && GIT_WORK_TREE=${ROOT} git add -A`,
    `export GIT_DIR="${ROOT}/.git" && cd "${WT}" && git commit -m x`,
    `cd "${WT}" && env GIT_DIR=${ROOT}/.git git commit -m x`,
  ]) assert.match(sh(c, impl).reason ?? '', redirect, c);
  assert.match(ps(`$env:GIT_DIR = "${ROOT}/.git"; cd "${WT}"; git commit -m x`, impl).reason ?? '', redirect);
  // Reads with --git-dir stay free.
  assert.equal(sh(`git --git-dir="${ROOT}/.git" log --oneline -3`, rev).decision, null);

  // Subcommand detection skips every global option, including ones with space-separated values.
  for (const c of ['git -P commit -m x', 'git --no-pager commit -m x', 'git --namespace foo commit -m x', `git -c user.name=x -C "${ROOT}" commit -m x`, 'git -c core.pager=cat --bare add -A']) {
    assert.match(sh(c, impl, ROOT).reason ?? '', /must run inside your claimed worktree/, c);
    assert.match(sh(c, rev, ROOT).reason ?? '', /Only an implementer with a claimed worktree/, c);
  }
  assert.equal(sh(`git -C "${WT}" -P -c a=b --namespace n commit -m x`, impl, ROOT).decision, null);
  assert.equal(sh('git -P log --oneline', rev).decision, null);
  assert.equal(sh('git --namespace foo log', rev).decision, null);
  assert.equal(sh('git -c core.pager=cat show HEAD', rev).decision, null);

  // Read-only stash/clean for agents without a claim.
  for (const c of ['git stash list', 'git stash show -p stash@{0}', 'git clean -n', 'git clean --dry-run -d', 'git clean -nd']) {
    assert.equal(sh(c, rev, WT).decision, null, c);
  }
  assert.equal(sh('git stash', rev, WT).decision, 'deny');
  assert.equal(sh('git stash pop', rev, WT).decision, 'deny');
  assert.equal(sh('git clean -d', rev, WT).decision, 'deny');
  assert.equal(sh(`cd "${WT}" && git checkout main`, impl).reason, 'Task agents stay on their task branch.');
  assert.equal(sh(`cd "${WT}" && git checkout -b feature-x`, impl).decision, null);

  // A heredoc commit message mentioning .factory/, pipes and separators (pilot / maintenance evidence).
  const msg = `cd "${WT}" && git add -A && git commit -m "$(cat <<'EOF'\nfix(T1): guard .factory/state and .inbox/x > y\n\nmaint start|claim|list; cd ${ROOT} && git checkout main; rm -rf .worktrees\nEOF\n)"`;
  assert.equal(sh(msg, impl).decision, null, sh(msg, impl).reason);
  assert.equal(sh(`cd "${WT}" && git commit -m "rm -rf .worktrees; echo x > .inbox/y"`, impl).decision, null);
  assert.equal(sh(`cd "${WT}" && git commit -F msg.txt`, impl).decision, null);
});

test('tree deletes of protected locations stay denied; mentions inside quotes do not', () => {
  assert.match(sh(`rm -rf ${paths().worktrees}`, rev).reason ?? '', /Deleting factory state/);
  assert.match(sh('rm -rf .factory', rev).reason ?? '', /Deleting factory state|Shell writes/);
  assert.match(ps('Remove-Item -Recurse -Force .worktrees\\g', rev).reason ?? '', /Deleting factory state/);
  assert.match(sh('find .inbox -name "*.json" -delete', rev).reason ?? '', /Deleting factory state|Shell writes/);
  assert.match(sh(`find ${paths().games} -type f | xargs rm -rf`, rev).reason ?? '', /Deleting factory state/);
  assert.equal(sh('echo "rm -rf .worktrees"', rev).decision, null);
  assert.equal(sh('cd /x/.worktrees/g/T1 && rm -rf dist', rev).decision, null);
});

// ---------------------------------------------------------------- review a1 repros (fail closed)

test('review a1 repros: every bypass is denied (lines that are not understood fall back to the old rules)', () => {
  const WT = norm(`${paths().worktrees}/${GAME}/T7`);
  const impl = { id: 'gdev7', type: 'game-developer' };
  applyEffects([{ type: 'claim', agentId: impl.id, rec: { game: GAME, task: 'T7', worktree: WT, attempt: 1, agentType: impl.type, claimedAt: new Date().toISOString() } }]);
  let nest = 'echo x > .inbox/a';
  for (let k = 0; k < 5; k++) nest = `bash -c ${JSON.stringify(nest)}`;
  const bashDeny = [
    // 1. moves out of .inbox/.factory change their source
    'mv .inbox/g/T1/review-a1.json /tmp/x',
    'rsync -a --remove-source-files .inbox/g/ /tmp/x/',
    // 2. node --eval= / -pe
    "node --eval=\"require('fs').writeFileSync('.inbox/x','y')\"",
    "node -pe \"require('fs').writeFileSync('.inbox/x','y')\"",
    // 3. shells and interpreters fed by a pipe, process substitution or stdin
    "echo 'echo x > .inbox/a' | bash",
    "echo \"require('fs').writeFileSync('.inbox/x','y')\" | node",
    "source <(echo 'echo x > .inbox/a')",
    '. /dev/stdin <<EOF\necho x > .inbox/a\nEOF',
    'bash -s -- arg <<EOF\necho x > .inbox/a\nEOF',
    // 5. ANSI-C quoting
    "echo $'\\'' >/dev/null; echo hi > .inbox/a; echo $'\\''",
    // 6. cmd /c
    'cmd /c "echo #x & echo y > .inbox\\a"',
    // 7. inline code that spawns or writes indirectly
    "node -e \"require('child_process').execSync('echo x > .inbox/a')\"",
    "python -c \"import os; os.system('echo x > .inbox/a')\"",
    "node -e \"fs['writeFileSync']('.inbox/x','y')\"",
    "node -e \"const {writeFileSync: w} = require('fs'); w(`.inbox/x`, 'y')\"",
    // 8. find -exec
    'find /tmp -name x -exec cp {} .inbox/ \\;',
    "find . -exec sh -c 'echo x > .inbox/a' \\;",
    // 9. nesting deeper than any limit
    nest,
    // minor: git -c with a program value
    'git -c core.fsmonitor="echo x > .inbox/a" status',
  ];
  for (const c of bashDeny) assert.equal(sh(c, rev).decision, 'deny', `expected deny: ${c}`);
  for (const c of [
    'Move-Item .factory\\games\\g\\events.jsonl C:\\tmp',
    "'Set-Content .inbox\\x y' | iex",
    "'a\u2019 ; Set-Content .inbox\\x y ; \u2018'",
  ]) assert.equal(ps(c, rev).decision, 'deny', `expected deny (PowerShell): ${c}`);

  // 2 / 9. CLI invocations behind options, wrappers and runners.
  for (const c of [
    'node --disable-warning ExperimentalWarning factory/cli/factory.mjs task start T1',
    'node --some-unknown-flag x factory/cli/factory.mjs task start T1',
    'env -S "node factory/cli/factory.mjs task start T1"',
    'pnpm exec node factory/cli/factory.mjs task start T1',
    'npx node factory/cli/factory.mjs task start T1',
    'bun factory/cli/factory.mjs task start T1',
  ]) assert.match(sh(c, rev).reason ?? '', /Only the orchestrator may run/, c);
  assert.equal(ps("Start-Process node -ArgumentList 'factory/cli/factory.mjs gate approve-spec'", rev).decision, 'deny');

  // 4. directory changes in { } groups and PowerShell blocks persist; cd options are skipped.
  assert.match(sh(`cd "${WT}" && { cd "${ROOT}"; } && git commit -m x`, impl).reason ?? '', /must run inside your claimed worktree/);
  assert.match(ps(`cd "${WT}"; & { Set-Location "${ROOT}" }; git commit -m x`, impl).reason ?? '', /must run inside your claimed worktree/);
  assert.match(sh(`cd "${WT}" && cd -L "${ROOT}" && git commit -m x`, impl).reason ?? '', /must run inside your claimed worktree/);
  assert.match(sh(`cd "${WT}" && cd -P "${ROOT}" && git commit -m x`, impl).reason ?? '', /must run inside your claimed worktree/);
  assert.equal(sh(`cd "${WT}" && (cd src && ls) && git commit -m x`, impl).decision, null, 'a real subshell cd does not leak');

  // Review a1 re-review: copy destinations behind GNU options after the paths, and PowerShell parameter prefixes.
  for (const c of [
    'cp a.json .inbox/g/ -S bak',
    'cp a.json .inbox/g/ --backup=numbered',
    'cp -v a.json .inbox/g/ b.json',
    'cp a.json b.json .inbox/g/ -v',
    'mv a.json .inbox/g/ -S bak',
  ]) assert.equal(sh(c, rev).decision, 'deny', `expected deny: ${c}`);
  for (const c of [
    'Copy-Item -Dest .inbox\\x -Path a.json',
    'Copy-Item -dest:.inbox\\x a.json',
    'Copy-Item -Path a.json .inbox\\x',
    'cp a.json -Destination .inbox\\x',
    'Move-Item -Dest .inbox\\x -Path a.json',
    'Move-Item -Pa a.json -De .factory\\x',
    'mi a.json -Dest .inbox\\x -Fo',
    'Copy-Item -Path a.json -ToSession $s -Destination .inbox\\x',
  ]) assert.equal(ps(c, rev).decision, 'deny', `expected deny (PowerShell): ${c}`);
  // Second re-review: attached option values and pipeline input (the copy/move class is closed as a class).
  for (const c of [
    'cp -t.inbox/g a.json',
    'mv -t.inbox/g a',
    'cp -vt.inbox/g a',
    'cp "-t.inbox/g" a.json',
    'cd .inbox && cp -tg a.json',
    `cd "${INBOX}/g" && cp -tg a.json`,
    `cd "${INBOX}/g" && cp /tmp/a.json b.json`,
    'cp --target-directory=.inbox/g a.json',
    'rsync -a /tmp/a/ --partial-dir=.inbox/x /tmp/b/',
    'install -D a.json .inbox/g/a.json',
    'ln -s /tmp/a .inbox/g/a',
    'tar -xf /tmp/a.tar -C.inbox/g',
    'tar --directory=.inbox/g -xf /tmp/a.tar',
    'mv .inbox/g/a.json .inbox/g/b.json',
  ]) assert.equal(sh(c, rev).decision, 'deny', `expected deny: ${c}`);
  for (const c of [
    'Get-ChildItem C:\\temp\\x | Copy-Item .inbox\\g',
    'Get-Item a.json | cp .inbox\\g',
    'Copy-Item -Path a.json -Destination:.inbox\\x',
    'Move-Item .inbox\\g\\a.json C:\\temp\\a.json',
  ]) assert.equal(ps(c, rev).decision, 'deny', `expected deny (PowerShell): ${c}`);
  // Copies out stay allowed with a plain first source.
  assert.equal(sh('cp .inbox/g/T1/report-a1.json /tmp/report.json', rev).decision, null);
  assert.equal(sh('cp -rv .inbox/g/T1 /tmp/out', rev).decision, null);
  assert.equal(sh('tar -xf .inbox/g/pack.tar -C /tmp/out', rev).decision, null);
  assert.equal(sh('tar -czf /tmp/out.tgz .inbox/g', rev).decision, null);
  assert.equal(ps('Copy-Item -Path .inbox\\g\\a.json -Dest C:\\temp\\a.json', rev).decision, null);
  assert.equal(ps('Copy-Item .inbox\\g\\a.json C:\\temp\\a.json', rev).decision, null);
  assert.equal(ps('Get-ChildItem .inbox\\g | Copy-Item -Destination C:\\temp\\y', rev).decision, null, 'pipeline copy out');

  // 10. integration worktree with an unknown directory (orchestrator).
  assert.match(sh('cd "$W/_integration" && git merge x').reason ?? '', /Integration\/release worktrees/);

  // Must-allow cases stay allowed.
  assert.equal(sh(`cd "${WT}" && git add -A && git commit -m "$(cat <<'EOF'\nfix: mv .inbox/a b; node -e x | bash\nEOF\n)"`, impl).decision, null);
  assert.equal(sh(`cd "${WT}" && node --test factory/cli/test/*.test.mjs 2>&1 | tail -20`, impl).decision, null);
  assert.equal(sh('sed -n 1,80p .inbox/g/T1/report-a1.json', rev).decision, null);
});

// ---------------------------------------------------------------- maintenance: reconciled (unverified), review attempt note

test('maint merge reconciliation is shown as "reconciled (unverified)" in maint list/show', () => {
  const ID = 'FX-55';
  const brief = `${INBOX}/_factory/${ID}/brief.md`;
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, '# Reconcile probe\n\nAdd z.txt.\n');
  M.startMaint(ID, { agent: 'tech-architect', reviewer: 'code-reviewer', brief });
  const arch = { id: 'arch55', type: 'tech-architect' };
  const reviewer = { id: 'rev55', type: 'code-reviewer' };
  const c = sh(`${CLI} maint claim ${ID}`, arch);
  assert.equal(c.decision, null, c.reason);
  applyEffects(c.effects);
  const W = M.maintWorktree(ID);
  fs.writeFileSync(`${W}/z.txt`, 'z\n');
  git(['add', '-A'], W);
  git(['commit', '-q', '-m', 'feat(FX-55): z'], W);
  const head = git(['rev-parse', 'HEAD'], W);
  agentWrite(M.maintReport(ID), JSON.stringify({ id: ID, attempt: 1, agent: arch.type, branch: `fx/${ID}`, head, summary: 'z', filesChanged: ['z.txt'], testsRun: [] }), arch);
  agentWrite(M.maintReview(ID), JSON.stringify({ taskId: ID, attempt: 1, reviewer: reviewer.type, head, verdict: 'ACCEPT', summary: 's', findings: [] }), reviewer);
  git(['merge', '--no-ff', '-q', '-m', `merge(${ID}): probe`, `fx/${ID}`], ROOT); // a merge that was never recorded
  const r = M.mergeMaint(ID);
  assert.equal(r.reconciled, true);
  assert.match(M.listMaint(), new RegExp(`${ID}\\tMERGED reconciled \\(unverified\\)\\t`));
  const s = M.showMaint(ID);
  assert.equal(s.verification, 'reconciled (unverified)');
  assert.match(s.next, /reconciled \(unverified\): the CLI did not re-run the verification/);

  // review check: the file name's attempt number vs the item's attempt.
  const old = `${INBOX}/_factory/${ID}/review-a0.json`;
  agentWrite(old, JSON.stringify({ taskId: ID, attempt: 1, reviewer: reviewer.type, head, verdict: 'ACCEPT', summary: 's', findings: [] }), reviewer);
  const chk = checkReviewFile(old, ID, '_factory');
  assert.ok(chk.notes.some((n) => /file name says attempt 0, but the task is at attempt 1: this is an old review/.test(n)), chk.notes.join('; '));
  assert.deepEqual(checkReviewFile(M.maintReview(ID), ID, '_factory').notes, []);
});
