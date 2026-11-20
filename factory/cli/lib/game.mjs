// @ts-check
/**
 * Game-level lifecycle and human gates.
 * Every forward transition that the brief reserves for the human consumes an HMAC-signed
 * approval token minted by the UserPromptSubmit hook and bound to the exact artifact hash.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  paths, git, run, readJson, writeJsonAtomic, writeTextAtomic, ensureDir, hashTree, listFiles, FactoryError,
  loadConfig, ID_RE, sha256File, nowIso,
} from './core.mjs';
import { loadState, commit, gameExists, setFocus, gameDir, listGames, rebuild, PRE_DEV_MODES, TASK_DONE } from './state.mjs';
import { liveAgents } from './claims.mjs';
import { requireToken, computeTarget } from './approvals.mjs';
import { validatePlan, validateAmendment } from './plan.mjs';
import { gameRepo, ensureIntegrationWorktree, gameConfig, integrationDir, assertProvenance, inboxDir } from './tasks.mjs';
import { zipDirectory, validateArchive } from './zip.mjs';
import { renderPhaseData } from './reports.mjs';
import { checkPacketCovers } from './covers.mjs';
import { withRunPort } from './runs.mjs';

const GIT_ID = ['-c', 'user.name=game-factory', '-c', 'user.email=factory@localhost.invalid'];

function guardMode(s, allowed, what) {
  if (!allowed.includes(s.mode)) {
    throw new FactoryError(`Cannot ${what}: game ${s.id} is in ${s.mode}; requires ${allowed.join(' or ')}.`, ['factory status']);
  }
  if (s.paused && what !== 'resume') throw new FactoryError(`Game ${s.id} is paused.`, ['User types /resume']);
}

// ---------------------------------------------------------------- creation

export function newGame(id, title) {
  if (!ID_RE.test(id)) throw new FactoryError(`Game id "${id}" must match ${ID_RE} (lowercase, digits, dashes).`);
  if (gameExists(id)) throw new FactoryError(`Game ${id} already exists.`);
  const repo = gameRepo(id);
  if (fs.existsSync(repo)) throw new FactoryError(`${repo} already exists on disk but is not registered; inspect it manually (never overwritten).`);
  ensureDir(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.name', 'game-factory'], repo);
  git(['config', 'user.email', 'factory@localhost.invalid'], repo);
  for (const d of ['concept', 'spec', 'research', 'tech']) {
    ensureDir(`${repo}/design/${d}`);
    fs.writeFileSync(`${repo}/design/${d}/.gitkeep`, '');
  }
  fs.writeFileSync(`${repo}/README.md`, `# ${title}\n\nGame repository managed by the Game Production Factory (id: \`${id}\`).\n`);
  fs.writeFileSync(`${repo}/.gitignore`, 'node_modules/\ndist/\ntest-results/\nplaywright-report/\n.cache/\n*.log\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', `chore: initialize game repository ${id}`], repo);
  const s = commit(id, [{ type: 'game.created', data: { title } }], { actor: 'orchestrator' });
  setFocus(id);
  return s;
}

function commitDesign(g, message) {
  const repo = gameRepo(g);
  git(['add', '-A', 'design'], repo);
  const staged = git(['diff', '--cached', '--name-only'], repo);
  if (staged) git(['commit', '-q', '-m', message], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

// ---------------------------------------------------------------- gates before development

export function approveConcept(g) {
  const s = loadState(g);
  guardMode(s, ['IDEATION'], 'approve the concept');
  const repo = gameRepo(g);
  if (!fs.existsSync(`${repo}/design/concept/concept-brief.md`)) throw new FactoryError('design/concept/concept-brief.md is missing.');
  const target = computeTarget('approve-concept', s, {}, repo);
  requireToken({ command: 'approve-concept', game: g, target, by: 'factory gate approve-concept' });
  const sha = commitDesign(g, 'design: concept approved');
  return commit(g, [{ type: 'concept.approved', data: { hash: target, commit: sha } }], { actor: 'human' });
}

export function startSpec(g) {
  const s = loadState(g);
  guardMode(s, ['CONCEPT_APPROVED'], 'start the specification');
  return commit(g, [{ type: 'spec.started' }], { actor: 'orchestrator' });
}

export const REQUIRED_SPEC_DOCS = ['README.md', 'gdd.md', 'tech-design.md', 'art-audio.md', 'playgama-integration.md', 'test-plan.md'];

export function approveSpec(g) {
  const s = loadState(g);
  guardMode(s, ['SPEC_DRAFT'], 'approve the specification');
  const repo = gameRepo(g);
  const missing = REQUIRED_SPEC_DOCS.filter((f) => !fs.existsSync(`${repo}/design/spec/${f}`));
  if (missing.length) throw new FactoryError(`Specification incomplete; missing design/spec/${missing.join(', design/spec/')}`);
  const target = computeTarget('approve-spec', s, {}, repo);
  requireToken({ command: 'approve-spec', game: g, target, by: 'factory gate approve-spec' });
  const sha = commitDesign(g, 'design: specification approved');
  return commit(g, [{ type: 'spec.approved', data: { hash: target, commit: sha } }], { actor: 'human' });
}

/** /start-development: freeze spec, create develop, scaffold template + pinned kit, baseline checks. */
export function startDevelopment(g, { template = 'game-phaser-ts' } = {}) {
  const s = loadState(g);
  guardMode(s, ['SPEC_APPROVED'], 'start development');
  const repo = gameRepo(g);
  const current = hashTree(`${repo}/design/spec`);
  if (current !== s.hashes.spec) {
    throw new FactoryError('The specification changed after it was approved. Approved specs cannot change silently.', ['Re-approve: user types /approve-spec after reviewing']);
  }
  requireToken({ command: 'start-development', game: g, target: s.hashes.spec, by: 'factory gate start-development' });
  commit(g, [{ type: 'dev.authorized', data: { hash: s.hashes.spec } }], { actor: 'human' });
  const scaffold = scaffoldGame(g, template);
  return { state: commit(g, [{ type: 'game.scaffolded', data: scaffold }]), scaffold };
}

function scaffoldGame(g, template) {
  const repo = gameRepo(g);
  const s = loadState(g);
  if (git(['rev-parse', '--verify', '--quiet', 'develop'], repo, { allowFail: true }).code !== 0) git(['branch', 'develop', 'main'], repo);
  const iwt = ensureIntegrationWorktree(g);
  const tdir = `${paths().templates}/${template}`;
  if (!fs.existsSync(tdir)) throw new FactoryError(`Template ${template} not found at ${tdir}`);
  const kit = renderTemplate(tdir, iwt, g, s.title);
  const pm = loadConfig().packageManager;
  const cfg = gameConfig(iwt);
  // First install resolves and writes the lockfile; later installs are frozen.
  const installCmd = (cfg.commands.scaffoldInstall || cfg.commands.install).replace(/^pnpm /, `${pm} `);
  return withRunPort(`scaffold ${g}`, (res) => {
    const install = run(installCmd, { cwd: iwt, env: res.env });
    if (install.exitCode !== 0) throw new FactoryError(`Scaffold install failed:\n${install.tail}`);
    git([...GIT_ID, 'add', '-A'], iwt);
    git([...GIT_ID, 'commit', '-q', '-m', `chore: scaffold from ${template} with pg-kit ${kit.version}`], iwt);
    const baseline = [];
    for (const name of cfg.regression) {
      const r = run(cfg.commands[name].replace(/^pnpm /, `${pm} `), { cwd: iwt, env: { CI: '1', ...res.env } });
      baseline.push({ name, ok: r.exitCode === 0, durationMs: r.durationMs, tail: r.exitCode ? r.tail : undefined });
      if (r.exitCode) throw new FactoryError(`Baseline "${name}" failed on the fresh scaffold (E2E_PORT=${res.port}); the template is broken:\n${r.tail}`);
    }
    return { template, kitVersion: kit.version, head: git(['rev-parse', 'HEAD'], iwt), baseline, port: res.port };
  });
}

/** Copy a template into dest with placeholder substitution and vendor the latest packed kit. */
export function renderTemplate(tdir, dest, gameId, title) {
  const kit = latestKitTarball();
  const vars = { __GAME_ID__: gameId, __GAME_TITLE__: title, __KIT_VERSION__: kit.version, __KIT_FILE__: path.basename(kit.file) };
  for (const rel of listFiles(tdir)) {
    if (/^(node_modules|dist|test-results|playwright-report)\//.test(rel) || rel === 'pnpm-lock.yaml') continue;
    const out = `${dest}/${rel.replace(/(^|\/)_(gitignore|gitattributes|npmrc)$/, '$1.$2')}`;
    ensureDir(path.dirname(out));
    const buf = fs.readFileSync(`${tdir}/${rel}`);
    if (/\.(json|ts|js|mjs|html|md|css|txt)$|^_/.test(path.basename(rel))) {
      let text = buf.toString('utf8');
      for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v);
      fs.writeFileSync(out, text);
    } else fs.writeFileSync(out, buf);
  }
  ensureDir(`${dest}/vendor`);
  fs.copyFileSync(kit.file, `${dest}/vendor/${path.basename(kit.file)}`);
  return kit;
}

/** Template CI: render into a scratch dir with the real kit and run the full regression suite. */
export function checkTemplate(template) {
  const tdir = `${paths().templates}/${template}`;
  if (!fs.existsSync(tdir)) throw new FactoryError(`Template ${template} not found`);
  const base = `${paths().root}/.cache/template-check`;
  for (const old of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    try { fs.rmSync(`${base}/${old}`, { recursive: true, force: true }); } catch { /* in use: leave it */ }
  }
  const dest = `${base}/${template}-${Date.now()}`;
  const kit = renderTemplate(tdir, dest, 'template-check', 'Template Check');
  const cfg = gameConfig(dest);
  const pm = loadConfig().packageManager;
  const results = [];
  const port = withRunPort(`template check ${template}`, (res) => {
    for (const name of ['scaffoldInstall', ...cfg.regression]) {
      const cmd = (cfg.commands[name] || '').replace(/^pnpm /, `${pm} `);
      const r = run(cmd, { cwd: dest, env: { CI: '1', ...res.env } });
      results.push({ name, ok: r.exitCode === 0, durationMs: r.durationMs, tail: r.exitCode ? r.tail : undefined });
      if (name === 'scaffoldInstall' && r.exitCode) break;
    }
    return res.port;
  });
  return { template, kit: kit.version, dir: dest, port, ok: results.every((r) => r.ok), results };
}

export function latestKitTarball() {
  const dir = `${paths().kit}/release`;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^pg-kit-\d+\.\d+\.\d+\.tgz$/.test(f)) : [];
  if (!files.length) throw new FactoryError('No packed pg-kit release found.', ['factory kit pack']);
  const ver = (f) => f.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
  files.sort((a, b) => { const x = ver(a); const y = ver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  const file = `${dir}/${files[files.length - 1]}`;
  return { file, version: files[files.length - 1].match(/\d+\.\d+\.\d+/)[0] };
}

// ---------------------------------------------------------------- requirement changes

export function openChangeRequest(g, text) {
  const s = loadState(g);
  if (['ARCHIVED', 'ABANDONED'].includes(s.mode)) throw new FactoryError(`Game ${s.mode === 'ARCHIVED' ? 'archived' : 'abandoned'}.`);
  if (s.openChangeRequest) throw new FactoryError('A change request is already open.');
  return commit(g, [{ type: 'change.requested', data: { text } }], { actor: 'human' });
}

export function refreezeSpec(g) {
  const s = loadState(g);
  if (!s.openChangeRequest) throw new FactoryError('No open change request.');
  const repo = gameRepo(g);
  const target = computeTarget('approve-spec-change', s, {}, repo);
  requireToken({ command: 'approve-spec-change', game: g, target, by: 'factory spec refreeze' });
  const sha = commitDesign(g, `design: specification change approved — ${s.openChangeRequest.text.slice(0, 60)}`);
  if (git(['rev-parse', '--verify', '--quiet', 'develop'], repo, { allowFail: true }).code === 0) {
    const iwt = ensureIntegrationWorktree(g);
    git([...GIT_ID, 'merge', '--no-ff', '--no-edit', '-m', 'spec: merge approved specification change', 'main'], iwt);
  }
  return commit(g, [{ type: 'spec.refrozen', data: { hash: target, commit: sha } }], { actor: 'human' });
}

// ---------------------------------------------------------------- plan

/**
 * Validate a plan amendment against the CURRENT plan of a game, exactly as `plan load --amend` does, without
 * writing anything (the state is rebuilt from the event log in memory; no snapshot is written).
 * @param {string} g
 * @param {any} amend parsed amendment JSON
 * @param {{testTreeMaxCriteria?: number, state?: any}} [opts]
 */
export function checkAmendment(g, amend, opts = {}) {
  const s = opts.state || rebuild(g);
  guardMode(s, ['DEVELOPMENT'], 'amend the plan');
  return { state: s, ...validateAmendment(amend, s, opts) };
}

export function loadPlan(g, planFile, { amend = false, testTreeMaxCriteria = undefined } = {}) {
  const s = loadState(g);
  const plan = readJson(planFile);
  if (amend) {
    const { tasks, modified, warnings } = checkAmendment(g, plan, { state: s, testTreeMaxCriteria });
    const data = { tasks, modified, source: planFile };
    // Re-checked under the lock: a task started meanwhile is refused by the reducer before anything is written.
    return { state: commit(g, [{ type: 'plan.amended', data }]), warnings, tasks, modified };
  }
  guardMode(s, ['DEV_AUTHORIZED'], 'load the development plan');
  const { phases, tasks, warnings } = validatePlan(plan, { testTreeMaxCriteria });
  const baseHead = git(['rev-parse', 'develop'], gameRepo(g));
  return { state: commit(g, [{ type: 'plan.loaded', data: { phases, tasks, baseHead, source: planFile } }]), warnings };
}

// ---------------------------------------------------------------- phases

export function checkpointPhase(g) {
  const s = loadState(g);
  guardMode(s, ['DEVELOPMENT'], 'checkpoint the phase');
  const p = s.phases.find((x) => x.n === s.currentPhase);
  if (!p || p.status !== 'RUNNING') throw new FactoryError('No running phase to checkpoint.');
  const tasks = Object.values(s.tasks).filter((t) => t.phase === p.n);
  const open = tasks.filter((t) => !['INTEGRATED', 'ABANDONED'].includes(t.status));
  if (open.length) throw new FactoryError(`Phase ${p.n} has unfinished tasks: ${open.map((t) => `${t.id}(${t.status})`).join(', ')}`);
  const iwt = ensureIntegrationWorktree(g);
  const cfg = gameConfig(iwt);
  const pm = loadConfig().packageManager;
  const dir = `${gameDir(g)}/evidence/phase-${p.n}`;
  ensureDir(`${dir}/logs`);
  const steps = cfg.checkpoint || cfg.regression;
  const results = [];
  const port = withRunPort(`checkpoint ${g} phase ${p.n}`, (res) => {
    for (const name of steps) {
      const r = run(cfg.commands[name].replace(/^pnpm /, `${pm} `), { cwd: iwt, env: { CI: '1', ...res.env } });
      fs.writeFileSync(`${dir}/logs/${name}.log`, `$ ${r.cmd}\nexit ${r.exitCode} (E2E_PORT=${res.port})\n\n${r.output}`);
      results.push({ name, ok: r.exitCode === 0, durationMs: r.durationMs, tail: r.exitCode ? r.tail : undefined });
    }
    return res.port;
  });
  const head = git(['rev-parse', 'HEAD'], iwt);
  const ok = results.every((r) => r.ok);
  const evidence = { head, ok, port, results, ts: nowIso() };
  writeJsonAtomic(`${dir}/checkpoint.json`, evidence);
  const report = `${gameDir(g)}/reports/phase-${p.n}-data.md`;
  writeTextAtomic(report, renderPhaseData(g, s, p, evidence));
  if (!ok) {
    return { ok: false, phase: p.n, results, report, message: 'Checkpoint regression failed; the phase stays RUNNING. Create corrective tasks (plan amend).' };
  }
  commit(g, [{ type: 'phase.checkpoint', data: { n: p.n, evidence, report } }]);
  return { ok: true, phase: p.n, head, results, report };
}

export function approvePhase(g) {
  const s = loadState(g);
  guardMode(s, ['DEVELOPMENT'], 'approve the phase');
  const p = s.phases.find((x) => x.n === s.currentPhase);
  if (p?.status !== 'CHECKPOINT') throw new FactoryError(`Phase ${p?.n} is ${p?.status}; it must be CHECKPOINT (all tasks integrated, regression green) before approval.`);
  const target = computeTarget('approve-phase', s, {}, gameRepo(g));
  requireToken({ command: 'approve-phase', game: g, target, by: 'factory gate approve-phase' });
  const nextBaseHead = git(['rev-parse', 'develop'], gameRepo(g));
  return commit(g, [{ type: 'phase.approved', data: { n: p.n, nextBaseHead } }], { actor: 'human' });
}

export function rejectPhase(g, reason) {
  const s = loadState(g);
  const p = s.phases.find((x) => x.n === s.currentPhase);
  if (p?.status !== 'CHECKPOINT') throw new FactoryError('Only a phase at CHECKPOINT can be rejected.');
  return commit(g, [{ type: 'phase.rejected', data: { n: p.n, reason } }], { actor: 'human' });
}

export function setPaused(g, paused) {
  const s = loadState(g);
  if (s.paused === paused) return s;
  return commit(g, [{ type: paused ? 'game.paused' : 'game.resumed' }], { actor: 'human' });
}

// ---------------------------------------------------------------- playtest & release

export function preparePlaytest(g) {
  const s = loadState(g);
  guardMode(s, ['RC_READY', 'PLAYTEST'], 'prepare the playtest build');
  const iwt = ensureIntegrationWorktree(g);
  const cfg = gameConfig(iwt);
  const pm = loadConfig().packageManager;
  const results = [];
  const port = withRunPort(`playtest ${g}`, (res) => {
    for (const name of cfg.release) {
      const r = run(cfg.commands[name].replace(/^pnpm /, `${pm} `), { cwd: iwt, env: { CI: '1', ...res.env } });
      results.push({ name, ok: r.exitCode === 0, durationMs: r.durationMs, tail: r.exitCode ? r.tail : undefined });
      if (r.exitCode) throw new FactoryError(`Release-candidate check "${name}" failed (E2E_PORT=${res.port}):\n${r.tail}`);
    }
    return res.port;
  });
  const head = git(['rev-parse', 'HEAD'], iwt);
  const rcDir = `${gameDir(g)}/rc/${head.slice(0, 10)}`;
  fs.rmSync(rcDir, { recursive: true, force: true });
  fs.cpSync(`${iwt}/${cfg.distDir || 'dist'}`, rcDir, { recursive: true });
  const sha = hashTree(rcDir);
  return commit(g, [{ type: 'playtest.prepared', data: { sha, head, dir: rcDir, port, results } }]);
}

export function approvePlaytest(g) {
  const s = loadState(g);
  guardMode(s, ['PLAYTEST'], 'approve the playtest');
  requireToken({ command: 'approve-playtest', game: g, target: s.rc.sha, by: 'factory gate approve-playtest' });
  return commit(g, [{ type: 'playtest.approved', data: { sha: s.rc.sha } }], { actor: 'human' });
}

export function rejectPlaytest(g, reason) {
  const s = loadState(g);
  guardMode(s, ['PLAYTEST'], 'reject the playtest');
  return commit(g, [{ type: 'playtest.rejected', data: { reason, exitCriteria: [`All issues from playtest feedback resolved: ${reason.slice(0, 200)}`] } }], { actor: 'human' });
}

export function approveRelease(g, version) {
  const s = loadState(g);
  guardMode(s, ['PLAYTEST_APPROVED'], 'approve the release');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new FactoryError('Version must be semver x.y.z');
  const target = computeTarget('approve-release', s, { version }, gameRepo(g));
  requireToken({ command: 'approve-release', game: g, target, by: 'factory gate approve-release' });
  const repo = gameRepo(g);
  const developHead = git(['rev-parse', 'develop'], repo);
  if (developHead !== s.rc.head) throw new FactoryError(`develop moved since the playtest build (${s.rc.head.slice(0, 10)} -> ${developHead.slice(0, 10)}); a new playtest is required.`);
  if (git(['status', '--porcelain'], repo)) throw new FactoryError(`${repo} (main checkout) has uncommitted changes; refusing to merge.`);
  if (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo) !== 'main') throw new FactoryError('Main checkout is not on branch main.');
  const tag = `v${version}`;
  if (git(['rev-parse', '--verify', '--quiet', tag], repo, { allowFail: true }).code === 0) throw new FactoryError(`Tag ${tag} already exists.`);
  git([...GIT_ID, 'merge', '--no-ff', '-m', `release: ${s.title} ${tag}`, 'develop'], repo);
  git([...GIT_ID, 'tag', '-a', tag, '-m', `${s.title} ${tag} (rc ${s.rc.sha.slice(0, 12)})`], repo);
  const mainCommit = git(['rev-parse', 'HEAD'], repo);
  return commit(g, [{ type: 'release.approved', data: { version, tag, mainCommit } }], { actor: 'human' });
}

export function packageRelease(g) {
  const s = loadState(g);
  guardMode(s, ['RELEASE_APPROVED'], 'package the release');
  const { version, tag } = s.release;
  const repo = gameRepo(g);
  const wt = `${paths().worktrees}/${g}/_release-${version}`;
  if (!fs.existsSync(wt)) git(['worktree', 'add', '--detach', wt, tag], repo);
  const cfg = gameConfig(wt);
  const pm = loadConfig().packageManager;
  const results = [];
  const port = withRunPort(`release ${g} ${version}`, (res) => {
    for (const name of cfg.release) {
      const r = run(cfg.commands[name].replace(/^pnpm /, `${pm} `), { cwd: wt, env: { CI: '1', ...res.env } });
      results.push({ name, ok: r.exitCode === 0, durationMs: r.durationMs });
      if (r.exitCode) throw new FactoryError(`Release step "${name}" failed on tag ${tag} (E2E_PORT=${res.port}):\n${r.tail}`);
    }
    return res.port;
  });
  const out = `${paths().archive}/${g}/${version}`;
  ensureDir(out);
  const zip = `${out}/${g}-${version}.zip`;
  const z = zipDirectory(`${wt}/${cfg.distDir || 'dist'}`, zip);
  const limits = loadConfig().release || { maxBytes: 25 * 1048576, maxFiles: 250, maxFileBytes: 10 * 1048576 };
  const validation = validateArchive(zip, limits);
  if (!validation.ok) throw new FactoryError(`Archive validation failed:\n - ${validation.errors.join('\n - ')}`);
  const sha256 = sha256File(zip);
  fs.writeFileSync(`${zip}.sha256`, `${sha256}  ${path.basename(zip)}\n`);
  for (const f of ['assets/LICENSES.json', 'CREDITS.md']) if (fs.existsSync(`${wt}/${f}`)) fs.copyFileSync(`${wt}/${f}`, `${out}/${path.basename(f)}`);
  const data = { zip, sha256, files: z.files, bytes: z.bytes, validation, results, tag, port };
  writeJsonAtomic(`${out}/package.json`, data);
  return commit(g, [{ type: 'release.packaged', data }]);
}

// ---------------------------------------------------------------- publication & archive

const REQUIRED_FORM = ['title', 'description', 'howToPlayText', 'category', 'supportedDevices', 'supportedLanguages'];

export function preparePublication(g) {
  const s = loadState(g);
  guardMode(s, ['PACKAGED'], 'prepare publication');
  const file = `${paths().inbox}/${g}/publication/packet.json`;
  assertProvenance(file, ['release-manager']);
  const pkt = readJson(file);
  const errors = [];
  for (const k of REQUIRED_FORM) if (pkt.form?.[k] === undefined || pkt.form?.[k] === '') errors.push(`form.${k} missing`);
  if ((pkt.form?.description || '').length < 100) errors.push('form.description must be >= 100 characters');
  if ((pkt.form?.howToPlayText || '').length < 100) errors.push('form.howToPlayText must be >= 100 characters');
  // FX-04: covers are accepted only from <inbox>/<game>/publication/covers/, as produced by `factory publish covers`
  // for the current packaged build (sha256 of every image checked against covers.json and the recorded event).
  errors.push(...checkPacketCovers(g, s, pkt));
  if (pkt.archiveSha256 !== s.release.package.sha256) errors.push('packet.archiveSha256 does not match the packaged build');
  const ledger = readJson(`${path.dirname(s.release.package.zip)}/LICENSES.json`, { assets: [] });
  const testOnly = (ledger.assets || []).filter((a) => a.testOnly);
  if (testOnly.length) errors.push(`build contains ${testOnly.length} TEST-ONLY asset(s); this game can never be published (replace them with releasable assets)`);
  if (errors.length) throw new FactoryError(`Publication packet invalid:\n - ${errors.join('\n - ')}`);
  return commit(g, [{ type: 'publication.prepared', data: { packet: file } }]);
}

/** PNG / JPEG dimensions without dependencies. */
export function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/**
 * FX-15: /abandon-game — drop a draft game before development. Allowed only in PRE_DEV_MODES, with a non-empty reason,
 * no open change request, no live claim and no unfinished task. Every refusal happens BEFORE the token is consumed.
 * The game repo and the event log stay (append-only); the next step is /archive-game.
 * @param {string} g @param {unknown} reason
 */
export function abandonGame(g, reason) {
  const s = loadState(g);
  if (!PRE_DEV_MODES.includes(s.mode)) {
    throw new FactoryError(`Cannot abandon the game: game ${g} is in ${s.mode}; only a draft game (${PRE_DEV_MODES.join(', ')}) can be abandoned.`,
      s.mode === 'ABANDONED' ? ['User types /archive-game'] : ['Games in development or later are not abandoned (out of scope)', 'factory status']);
  }
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw new FactoryError('A reason is required: factory gate abandon-game --reason "<text>".', [`The reason the user typed after /abandon-game (e.g. "superseded by another game")`]);
  if (s.openChangeRequest) throw new FactoryError(`Game ${g} has an open change request ("${s.openChangeRequest.text.slice(0, 60)}"); resolve it first.`, ['User types /approve-spec-change after the amended spec is ready']);
  const open = Object.values(s.tasks).filter((t) => !TASK_DONE.has(t.status));
  if (open.length) throw new FactoryError(`Game ${g} has unfinished tasks: ${open.map((t) => `${t.id}(${t.status})`).join(', ')}.`, ['factory status']);
  const live = liveAgents().filter(([, a]) => a.game === g && a.task);
  if (live.length) {
    throw new FactoryError(`Game ${g} has live claims: ${live.map(([id, a]) => `${id} (${a.agentType}) ${a.task}`).join(', ')}.`,
      ['Wait for the agents to finish', 'factory recover (stale claims: factory recover --apply)']);
  }
  requireToken({ command: 'abandon-game', game: g, target: computeTarget('abandon-game', s, {}, gameRepo(g)), by: 'factory gate abandon-game' });
  return commit(g, [{ type: 'game.abandoned', data: { reason: text, fromMode: s.mode } }], { actor: 'human' });
}

/** FX-15: archive folder of an abandoned game, named after the UTC date of its game.abandoned event. */
export function abandonedArchiveDir(g, s) {
  const day = String(s.abandoned?.ts || '').slice(0, 10).replace(/-/g, '') || 'undated';
  return `${paths().archive}/${g}/abandoned-${day}`;
}

/**
 * /archive-game. Released games (PACKAGED, PUBLICATION_PREPARED) go to <archive>/<id>/<version>/production;
 * abandoned drafts (FX-15) go to <archive>/<id>/abandoned-<YYYYMMDD>/{production,design}. Production records are
 * committed into the game repo (abandoned drafts also commit design/). Nothing is deleted.
 */
export function archiveGame(g) {
  const s = loadState(g);
  const abandoned = s.mode === 'ABANDONED';
  if (PRE_DEV_MODES.includes(s.mode)) {
    throw new FactoryError(`Cannot archive the game: game ${g} is in ${s.mode}; requires PACKAGED, PUBLICATION_PREPARED or ABANDONED.`,
      [`A draft game is abandoned first: the user types /abandon-game ${g} <reason>, then /archive-game`]);
  }
  // An abandoned draft may have been paused before; the pause does not hold back its archiving.
  if (!abandoned) guardMode(s, ['PACKAGED', 'PUBLICATION_PREPARED', 'ABANDONED'], 'archive the game');
  requireToken({ command: 'archive-game', game: g, target: `archive:${g}`, by: 'factory gate archive-game' });
  const base = abandoned ? abandonedArchiveDir(g, s) : `${paths().archive}/${g}/${s.release.version}`;
  const out = `${base}/production`;
  ensureDir(out);
  fs.cpSync(gameDir(g), out, { recursive: true, filter: (src) => !/[\\/](\.lock|rc)([\\/]|$)/.test(src) });
  const repo = gameRepo(g);
  const data = { dir: out };
  if (abandoned) {
    Object.assign(data, { fromMode: 'ABANDONED', reason: s.abandoned?.reason ?? null });
    if (fs.existsSync(`${repo}/design`)) {
      fs.cpSync(`${repo}/design`, `${base}/design`, { recursive: true });
      data.design = `${base}/design`;
    }
  }
  // A draft whose repo was removed by hand is still archived from the factory records.
  if (!abandoned || fs.existsSync(`${repo}/.git`)) {
    ensureDir(`${repo}/production`);
    if (fs.existsSync(`${gameDir(g)}/reports`)) fs.cpSync(`${gameDir(g)}/reports`, `${repo}/production/reports`, { recursive: true });
    fs.copyFileSync(`${gameDir(g)}/events.jsonl`, `${repo}/production/events.jsonl`);
    git([...GIT_ID, 'add', '-A', 'production', ...(abandoned && fs.existsSync(`${repo}/design`) ? ['design'] : [])], repo);
    if (git(['diff', '--cached', '--name-only'], repo)) git([...GIT_ID, 'commit', '-q', '-m', abandoned ? 'chore: archive abandoned draft (production records + design)' : 'chore: archive production records'], repo);
    if (abandoned) data.repoCommit = git(['rev-parse', 'HEAD'], repo);
  }
  return commit(g, [{ type: 'game.archived', data }], { actor: 'human' });
}

export function allGames() {
  return listGames().map((g) => loadState(g));
}

export { integrationDir, inboxDir };
