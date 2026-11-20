#!/usr/bin/env node
// @ts-check
/**
 * factory — deterministic control plane of the Game Production Factory.
 * Only the orchestrator (main thread) may run state-changing commands; hooks enforce this.
 * Run `node factory/cli/factory.mjs help` for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, paths, readJson, run, sha256File, ensureDir, loadConfig, readJsonl } from './lib/core.mjs';
import { loadState, resolveGame, setFocus, listGames, readyTasks, commit, gameExists } from './lib/state.mjs';
import * as G from './lib/game.mjs';
import * as T from './lib/tasks.mjs';
import { statusText, factoryOverview, metrics, recover, nextActions } from './lib/reports.mjs';
import { validatePlan, describeModification } from './lib/plan.mjs';
import { requireToken, findToken, PUBLISH_OPS, verifySig } from './lib/approvals.mjs';
import * as A from './lib/assets.mjs';
import * as M from './lib/maint.mjs';
import * as C from './lib/covers.mjs';
import { dispatchAgent, pinFor } from './lib/agents.mjs';
import { renderReviewSchema } from './lib/review-schema.mjs';
import { checkReviewFile, reviewContextFor } from './lib/review-check.mjs';

const HELP = `factory <command> [args] [--game <id>] [--json]

Status
  status [--brief]                         Factory/game status + next permitted actions
  game list | game focus <id> | game new <id> --title "<title>"
  metrics                                  Production metrics from event logs
  recover [--apply]                        Reconcile state after interruptions
  recover --apply --clear-verify-marker <TASK>[,<TASK>] [--game <id>]
                                           Clear a verify marker whose pid was reused (check the pid first)
  decisions                                Audit log of human approvals/decisions
  doctor                                   Environment readiness (incl. pinned agent models)

Pre-development (gates consume human tokens minted when the USER types the slash command)
  gate approve-concept | spec start | gate approve-spec | gate start-development [--template t]
  spec change-request --text "..."  | spec refreeze      (after /modify-requirements, /approve-spec-change)
  gate abandon-game --reason "<text>"
                             (after /abandon-game <reason>: drop a draft game in IDEATION, CONCEPT_APPROVED, SPEC_DRAFT
                              or SPEC_APPROVED -> ABANDONED; refused with an open change request, unfinished tasks or
                              live claims. Then /archive-game + gate archive-game -> ARCHIVED)

Development
  plan validate <file> [--test-tree-max-criteria N]
                             (full plan; L-01 WARNING when one task owns a whole test tree with > N criteria,
                              default config planTestTreeMaxCriteria or 25)
  plan validate <file> --amend [--game <id>]
                             (read-only: an amendment { tasks?, modify? } against the game's CURRENT plan,
                              same checks as plan load --amend; prints the before/after of every modification)
  plan load <file> [--amend] (--amend: add tasks and/or modify PENDING never-started tasks; event plan.amended)
  task next | task show <id>
  task start <id>            (prints "Dispatch to: <agent>": attempt 1 = task agent, attempts >= 2 = <agent>-retry;
                              models are pinned in .claude/agents, there is no --model/--effort)
  task claim <id>            (subagent first action; prints packet)
  task submit <id>           (ingest report + deterministic verification)
  task verify <id>           (re-run verification)
  task review-packet <id>    (write <inbox>/<game>/<id>/review-packet-a<n>.md; dispatch the reviewer with that path)
  task review <id>           (ingest independent review verdict; strict schema, every problem listed)
  task integrate <id>        (no-ff merge + regression; auto-revert on failure)
  task release-claim <id> [--agent <agentId>] [--reason "..."]
                             (orchestrator only: the agent of the current attempt stopped mid-attempt; releases its
                              claim and marks it inactive, then re-dispatch the SAME attempt to a fresh agent.
                              task start of a new attempt supersedes older claims automatically)
  task retry <id> | task abandon <id> | task blocker-note <id>
  phase checkpoint | gate approve-phase | phase reject --reason "..."
  pause | resume

Release
  playtest prepare | gate approve-playtest | playtest reject --reason "..." | playtest serve [--port 4173]
  gate approve-release --version x.y.z | release package
  publish covers [--title "..."] [--accept-canvas-only]
                             (orchestrator, PACKAGED, before prepare: serves the packaged archive, takes real Playwright
                              screenshots 800x800 / 1080x1920 / 1920x1080 into <inbox>/<game>/publication/covers/ + covers.json;
                              scenario: factory.game.json "covers". Shots taken without a game_ready signal are refused by
                              "publish prepare" unless --accept-canvas-only was given here (recorded in the event))
  publish prepare | publish status | publish can <op>
  gate archive-game          (after /archive-game: PACKAGED / PUBLICATION_PREPARED -> <archive>/<id>/<version>/production;
                              ABANDONED -> <archive>/<id>/abandoned-<YYYYMMDD>/{production,design}; mode ARCHIVED)

Factory maintenance (isolated worktrees of the factory repo; only the orchestrator merges into main)
  maint start <FX-ID> --agent <type> [--reviewer <type>] --brief <file> [--title "..."]
                             (worktree <worktrees>/_factory/<FX-ID>, branch fx/<FX-ID> from main, packet)
  maint claim <FX-ID>        (subagent first action; prints packet)
  maint release-claim <FX-ID> [--agent <agentId>] [--reason "..."]
                             (orchestrator only: the maintenance agent stopped; release its claim, re-dispatch)
  maint list | maint show <FX-ID>
  maint merge <FX-ID> [--message "..."]
                             (report + independent ACCEPT review of the branch head + clean worktree +
                              verification re-run by the CLI, then git merge --no-ff into main)

Reviews (read-only; also allowed for subagents)
  review schema [--task <id> --game <g>] [--maintenance]
                             (the review JSON schema with a filled example; with --task: that task's ids)
  review check <file> [--task <id> --game <g>]
                             (validate a review draft without recording anything; exit 1 if invalid;
                              task/game are inferred from <inbox>/<game>/<task>/review-a<n>.json when omitted;
                              --game _factory = factory maintenance review)

Shared kit & assets
  kit pack                                  Build + pack packages/pg-kit into an immutable versioned tarball
  assets <ingest|search|show|pull|verify|stats|reindex|sources|sync|acquire|preview|deny> ...   (see: factory assets help)
  template check [name]                     Scaffold + full verify of a game template
`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

function out(obj, flags) {
  if (flags.json || typeof obj !== 'string') console.log(typeof obj === 'string' ? JSON.stringify({ text: obj }) : JSON.stringify(obj, null, 2));
  else console.log(obj);
}

/** Decisions (pause/resume/rejections/change requests) also come only from the human. */
function requireDecision(command, game) {
  const recs = readJsonl(paths().approvals).reverse();
  const used = new Set(readJsonl(paths().consumed).map((c) => c.id));
  const ttl = loadConfig().approvalTtlHours * 3600 * 1000;
  const r = recs.find((x) => x.kind === 'decision' && x.command === command && (x.game === game || x.game === null) &&
    !used.has(x.id) && Date.now() - Date.parse(x.ts) < ttl && verifySig(x));
  if (!r) throw new FactoryError(`No human "/${command}" decision recorded for ${game}.`, [`Ask the user to type: /${command} ${game} <text>`]);
  fs.appendFileSync(paths().consumed, JSON.stringify({ id: r.id, ts: new Date().toISOString(), by: `factory ${command}` }) + '\n');
  return r;
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, arg] = pos;
  const game = () => resolveGame(typeof flags.game === 'string' ? flags.game : undefined);

  switch (cmd) {
    case undefined: case 'help': case '--help': return out(HELP, {});

    case 'status': {
      if (flags.game || (!flags.all && !flags.brief && listGames().length && resolveSafe())) {
        const g = game();
        const s = loadState(g);
        return flags.json ? out({ state: summarize(s), next: nextActions(s) }, flags) : out(statusText(s), flags);
      }
      return out(factoryOverview({ brief: !!flags.brief }), flags);
    }

    case 'game':
      if (sub === 'list') return out(listGames().map((g) => { const s = loadState(g); return `${g}\t${s.mode}\t${s.title}`; }).join('\n') || '(no games)', flags);
      if (sub === 'focus') { if (!gameExists(arg)) throw new FactoryError(`Unknown game ${arg}`); setFocus(arg); return out(`focus = ${arg}`, flags); }
      if (sub === 'new') {
        if (!arg || typeof flags.title !== 'string') throw new FactoryError('Usage: factory game new <id> --title "<title>"');
        const s = G.newGame(arg, flags.title);
        return out(`Created game ${arg} (${s.mode}); repo ${T.gameRepo(arg)}; design dirs ready. Focus set.`, flags);
      }
      break;

    case 'gate': {
      const g = game();
      const map = {
        'approve-concept': () => G.approveConcept(g),
        'approve-spec': () => G.approveSpec(g),
        'start-development': () => G.startDevelopment(g, { template: typeof flags.template === 'string' ? flags.template : undefined }),
        'approve-phase': () => G.approvePhase(g),
        'approve-playtest': () => G.approvePlaytest(g),
        'approve-release': () => G.approveRelease(g, String(flags.version || '')),
        'abandon-game': () => G.abandonGame(g, flags.reason),
        'archive-game': () => G.archiveGame(g),
      };
      if (!map[sub]) throw new FactoryError(`Unknown gate ${sub}. Gates: ${Object.keys(map).join(', ')}`);
      const r = map[sub]();
      const s = r.state || r;
      return out(`${sub}: OK -> ${s.mode}${r.scaffold ? `\nscaffold: ${JSON.stringify(r.scaffold.baseline.map((b) => `${b.name}:${b.ok ? 'pass' : 'fail'}`))} kit ${r.scaffold.kitVersion}` : ''}\n\n${statusText(s, { brief: true })}`, flags);
    }

    case 'spec': {
      const g = game();
      if (sub === 'start') return out(statusText(G.startSpec(g), { brief: true }), flags);
      if (sub === 'change-request') {
        const d = requireDecision('modify-requirements', g);
        return out(statusText(G.openChangeRequest(g, typeof flags.text === 'string' ? flags.text : d.args?.text || d.prompt), { brief: true }), flags);
      }
      if (sub === 'refreeze') return out(statusText(G.refreezeSpec(g), { brief: true }), flags);
      break;
    }

    case 'plan': {
      if (!arg) throw new FactoryError(`Usage: factory plan ${sub || 'validate|load'} <file> [--amend] [--game <id>] [--test-tree-max-criteria N]`);
      const maxCriteria = flags['test-tree-max-criteria'] === undefined ? undefined : Number(flags['test-tree-max-criteria']);
      if (maxCriteria !== undefined && !(Number.isInteger(maxCriteria) && maxCriteria >= 0)) throw new FactoryError('--test-tree-max-criteria must be a non-negative integer');
      const warnText = (w) => (w.length ? `\n${w.map((x) => `WARNING: ${x}`).join('\n')}` : '');
      const changeText = (mods) => mods.flatMap((m) => describeModification(m)).map((l) => `\n  ~ ${l}`).join('');
      if (sub === 'validate') {
        if (flags.amend) {
          // Read-only: validates against the current plan of the game (same checks as plan load --amend).
          const r = G.checkAmendment(game(), readJson(arg), { testTreeMaxCriteria: maxCriteria });
          return out(`Amendment valid for ${r.state.id}: ${r.tasks.length} new task(s), ${r.modified.length} modified task(s).${changeText(r.modified)}${warnText(r.warnings)}`, flags);
        }
        const r = validatePlan(readJson(arg), { testTreeMaxCriteria: maxCriteria });
        return out(`Plan valid: ${r.phases.length} phases, ${r.tasks.length} tasks.${warnText(r.warnings)}`, flags);
      }
      if (sub === 'load') {
        const g = game();
        const r = G.loadPlan(g, arg, { amend: !!flags.amend, testTreeMaxCriteria: maxCriteria });
        const what = flags.amend ? `Plan amended: ${r.tasks.length} new task(s), ${r.modified.length} modified task(s).${changeText(r.modified)}` : 'Plan loaded.';
        return out(`${what}${warnText(r.warnings)}\n${statusText(r.state)}`, flags);
      }
      break;
    }

    case 'task': {
      const g = game();
      switch (sub) {
        case 'next': {
          const s = loadState(g);
          const inProg = Object.values(s.tasks).filter((t) => t.status === 'IN_PROGRESS').length;
          const slots = Math.max(0, loadConfig().concurrency - inProg);
          const r = readyTasks(s);
          return out({
            concurrency: loadConfig().concurrency, inProgress: inProg, freeSlots: slots,
            ready: r.map((t) => {
              const n = t.attempts.length + 1;
              const to = dispatchAgent(t.agent, n);
              return { id: t.id, agent: t.agent, attempt: n, dispatchTo: to, model: pinFor(to)?.model ?? null, title: t.title };
            }),
          }, flags);
        }
        case 'show': { const s = loadState(g); const t = s.tasks[arg]; if (!t) throw new FactoryError(`Unknown task ${arg}`); return out(t, flags); }
        case 'start': {
          if (flags.model !== undefined || flags.effort !== undefined) throw new FactoryError(T.PINNED_MODELS_MSG, ['factory task start <id> (no --model/--effort)']);
          const r = T.startTask(g, arg);
          if (flags.json) return out(r, flags);
          const sup = r.supersededAgents.length ? `\nSuperseded claims of earlier attempts (agents deactivated): ${r.supersededAgents.join(', ')}` : '';
          return out(`${T.dispatchLine(r.dispatchTo, r.model, r.effort)}${sup}\n${JSON.stringify(r, null, 2)}`, flags);
        }
        case 'release-claim': {
          const r = T.releaseTaskClaim(g, arg, { agentId: typeof flags.agent === 'string' ? flags.agent : undefined, reason: typeof flags.reason === 'string' ? flags.reason : undefined });
          if (flags.json) return out(r, flags);
          return out(`Released claim of ${r.taskId} attempt ${r.attempt}: ${r.released.map((x) => `${x.agentId} (${x.agentType})`).join(', ')}\nNext: ${r.next}`, flags);
        }
        case 'claim': return out(T.claimInfo(g, arg), {});
        case 'submit': return out(T.submitTask(g, arg), flags);
        case 'verify': return out(T.verifyTask(g, arg), flags);
        case 'review': return out(T.recordReview(g, arg), flags);
        case 'review-packet': {
          const r = T.writeReviewPacket(g, arg);
          if (flags.json) return out(r, flags);
          return out(`Dispatch to: ${r.dispatchTo} (no model/effort) with the review packet only: ${r.packet}\nThen: ${r.next}\n${JSON.stringify(r, null, 2)}`, flags);
        }
        case 'integrate': return out(T.integrateTask(g, arg), flags);
        case 'blocker-note': return out(`updated ${T.blockerNote(g, arg)}`, flags);
        case 'retry': {
          requireToken({ command: 'retry-task', game: g, target: `task:${arg}`, by: 'factory task retry' });
          const s = commit(g, [{ type: 'task.retry_granted', data: { taskId: arg, extra: 2, resumeStatus: 'REJECTED' } }], {
            actor: 'human', guard: (s) => { if (s.tasks[arg]?.status !== 'BLOCKED') throw new FactoryError(`${arg} is not BLOCKED`); },
          });
          return out(`${arg} unblocked with 2 extra attempts (max ${s.tasks[arg].maxAttempts}). Next: factory task start ${arg}, then Dispatch to: ${dispatchAgent(s.tasks[arg].agent, s.tasks[arg].attempts.length + 1)}.`, flags);
        }
        case 'abandon': {
          requireToken({ command: 'abandon-task', game: g, target: `task:${arg}`, by: 'factory task abandon' });
          commit(g, [{ type: 'task.abandoned', data: { taskId: arg } }], { actor: 'human' });
          return out(`${arg} abandoned. Dependents must be re-planned (plan load --amend).`, flags);
        }
        default: break;
      }
      break;
    }

    case 'phase': {
      const g = game();
      if (sub === 'checkpoint') return out(G.checkpointPhase(g), flags);
      if (sub === 'reject') {
        const d = requireDecision('reject-phase', g);
        return out(statusText(G.rejectPhase(g, typeof flags.reason === 'string' ? flags.reason : d.args?.text || d.prompt), { brief: true }), flags);
      }
      break;
    }

    case 'pause': return out(statusText(G.setPaused(game(), true), { brief: true }), flags);
    case 'resume': { const g = game(); requireDecision('resume', g); return out(statusText(G.setPaused(g, false), { brief: true }), flags); }

    case 'playtest': {
      const g = game();
      if (sub === 'prepare') { const s = G.preparePlaytest(g); return out({ mode: s.mode, rc: s.rc }, flags); }
      if (sub === 'reject') {
        const d = requireDecision('reject-playtest', g);
        return out(statusText(G.rejectPlaytest(g, typeof flags.reason === 'string' ? flags.reason : d.args?.text || d.prompt), { brief: true }), flags);
      }
      if (sub === 'serve') {
        const s = loadState(g);
        if (!s.rc) throw new FactoryError('No release candidate prepared.');
        const port = Number(flags.port || 4173);
        return out(`Run (in background): node "${paths().root}/factory/cli/serve.mjs" "${s.rc.dir}" --port ${port}\nThen open http://localhost:${port}/`, flags);
      }
      break;
    }

    case 'release':
      if (sub === 'package') { const s = G.packageRelease(game()); return out({ mode: s.mode, package: s.release.package }, flags); }
      break;

    case 'publish': {
      const g = game();
      if (sub === 'covers') {
        const r = await C.makeCovers(g, { title: typeof flags.title === 'string' ? flags.title : undefined, acceptCanvasOnly: flags['accept-canvas-only'] === true });
        if (flags.json) return out({ dir: r.dir, manifest: r.manifest, warnings: r.warnings }, flags);
        const lines = Object.entries(r.manifest.covers).map(([k, v]) => `  ${k}: ${r.dir}/${v.file} (${v.width}x${v.height}, ${v.bytes} bytes, sha256 ${v.sha256.slice(0, 12)})`);
        return out(`Covers for ${g} (build ${r.manifest.build.sha256.slice(0, 12)}, ready signal ${r.manifest.readySignal}):\n${lines.join('\n')}\nManifest: ${r.dir}/covers.json\nReference exactly these paths in packet.json "covers" (square, portrait, landscape), then run: factory publish prepare${r.warnings.length ? `\nWARNING: ${r.warnings.join(' ')}` : ''}`, flags);
      }
      if (sub === 'prepare') return out(statusText(G.preparePublication(g), { brief: true }), flags);
      if (sub === 'status') { const s = loadState(g); return out({ mode: s.mode, prepared: s.publication.prepared, ops: s.publication.ops }, flags); }
      if (sub === 'can') {
        const s = loadState(g);
        const op = arg;
        if (!PUBLISH_OPS[op]) throw new FactoryError(`Unknown op ${op}. Ops: ${Object.keys(PUBLISH_OPS).join(', ')}`);
        const tok = findToken({ command: 'authorize-publish', game: g, op, target: `${op}@${s.release?.package?.sha256 ?? 'unpackaged'}`, ttlHours: PUBLISH_OPS[op].multiUse ? loadConfig().draftTokenTtlHours : undefined });
        return out(tok ? `AUTHORIZED: ${op} for ${g} (token ${tok.id.slice(0, 8)}, ${tok.ts})` : `NOT AUTHORIZED: user must type /authorize-publish ${op} ${g}  — ${PUBLISH_OPS[op].describe}`, flags);
      }
      break;
    }

    case 'maint': {
      const str = (k) => (typeof flags[k] === 'string' ? flags[k] : undefined);
      if (sub === 'start') {
        const r = M.startMaint(arg, { agent: str('agent'), reviewer: str('reviewer'), brief: str('brief') ? path.resolve(str('brief')) : undefined, title: str('title') });
        if (flags.json) return out(r, flags);
        return out(`${T.dispatchLine(r.dispatchTo, r.model, r.effort)}\nThen dispatch ${r.reviewer} for the review and run: factory maint merge ${r.id}\n${JSON.stringify(r, null, 2)}`, flags);
      }
      if (sub === 'claim') return out(M.claimMaintInfo(arg), {});
      if (sub === 'release-claim') {
        const r = M.releaseMaintClaim(arg, { agentId: str('agent'), reason: str('reason') });
        if (flags.json) return out(r, flags);
        return out(`Released claim of ${r.id}: ${r.released.map((x) => `${x.agentId} (${x.agentType})`).join(', ')}\nNext: ${r.next}`, flags);
      }
      if (sub === 'list') return out(M.listMaint(), flags);
      if (sub === 'show') return out(M.showMaint(arg), flags);
      if (sub === 'merge') return out(M.mergeMaint(arg, { message: str('message') }), flags);
      break;
    }

    case 'review': {
      const str = (k) => (typeof flags[k] === 'string' ? flags[k] : undefined);
      if (sub === 'schema') {
        const ctx = str('task') ? reviewContextFor(str('task'), str('game')).ctx : { maintenance: !!flags.maintenance };
        return out(renderReviewSchema(ctx), flags);
      }
      if (sub === 'check') {
        if (!arg) throw new FactoryError('Usage: factory review check <file> [--task <id> --game <g>]');
        const r = checkReviewFile(path.resolve(arg), str('task'), str('game'));
        if (!r.ok) process.exitCode = 1;
        if (flags.json) return out(r, flags);
        const head = r.ok ? `OK: ${r.file} is a valid review (${r.scope}). Nothing was recorded.` : `INVALID: ${r.file} (${r.scope}) — ${r.problems.length} problem(s):`;
        return out([head, ...r.problems.map((x) => `  - ${x}`), ...r.notes.map((x) => `note: ${x}`)].join('\n'), flags);
      }
      break;
    }

    case 'decisions': {
      const recs = readJsonl(paths().approvals).filter((r) => !flags.game || r.game === flags.game);
      const used = new Set(readJsonl(paths().consumed).map((c) => c.id));
      return out(recs.map((r) => `${r.ts} ${r.kind.padEnd(8)} /${r.command} game=${r.game} sig=${verifySig(r) ? 'valid' : 'INVALID'} ${used.has(r.id) ? 'consumed' : 'open'} ${r.args?.text ? `"${r.args.text}"` : ''}`).join('\n') || '(none)', flags);
    }

    case 'metrics': return out(metrics(), { json: true });
    case 'recover': {
      const clear = typeof flags['clear-verify-marker'] === 'string' ? flags['clear-verify-marker'].split(',').filter(Boolean) : [];
      if (flags['clear-verify-marker'] !== undefined && (!flags.apply || !clear.length)) {
        throw new FactoryError('Usage: factory recover --apply --clear-verify-marker <TASK>[,<TASK>] [--game <id>] (only after checking that the marker pid is not a running factory verify)');
      }
      const f = [...recover({ apply: !!flags.apply, clearVerifyMarkers: clear, game: typeof flags.game === 'string' ? flags.game : undefined }), ...M.maintFindings()];
      return out(f.length ? f.map((x) => `- [${x.kind}] ${x.game || ''} ${x.task || ''} ${x.detail || ''}\n    -> ${x.fix}`).join('\n') : 'Recovery: state and filesystem are consistent.', flags);
    }

    case 'kit':
      if (sub === 'pack') return out(packKit(), flags);
      break;

    case 'doctor': {
      const { doctor, renderDoctor } = await import('./lib/doctor.mjs');
      return out(renderDoctor(doctor()), flags);
    }

    case 'template':
      if (sub === 'check') {
        const r = G.checkTemplate(arg || 'game-phaser-ts');
        if (!r.ok) process.exitCode = 1;
        return out(r, { json: true });
      }
      break;

    case 'assets': return out(await A.assetsCommand(pos.slice(1), flags), flags);

    default: break;
  }
  throw new FactoryError(`Unknown command: ${pos.join(' ')}`, ['factory help']);
}

function resolveSafe() {
  try { return resolveGame(undefined); } catch { return null; }
}

function summarize(s) {
  return { id: s.id, title: s.title, mode: s.mode, paused: s.paused, currentPhase: s.currentPhase, phases: s.phases.map((p) => ({ n: p.n, name: p.name, status: p.status })), tasks: Object.values(s.tasks).map((t) => ({ id: t.id, phase: t.phase, status: t.status, agent: t.agent, attempts: t.attempts.length })), blockers: s.blockers, openChangeRequest: s.openChangeRequest };
}

function packKit() {
  const kit = paths().kit;
  const pkg = readJson(`${kit}/package.json`);
  const releaseDir = ensureDir(`${kit}/release`);
  const target = `${releaseDir}/pg-kit-${pkg.version}.tgz`;
  const pm = loadConfig().packageManager;
  for (const step of ['run build', 'run test']) {
    const r = run(`${pm} ${step}`, { cwd: kit });
    if (r.exitCode) throw new FactoryError(`pg-kit "${step}" failed:\n${r.tail}`);
  }
  const tmp = ensureDir(`${kit}/.pack-tmp`);
  const r = run(`${pm} pack --pack-destination "${tmp}"`, { cwd: kit });
  if (r.exitCode) throw new FactoryError(`pack failed:\n${r.tail}`);
  const produced = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  const src = path.join(tmp, produced);
  if (fs.existsSync(target)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new FactoryError(`pg-kit ${pkg.version} is already released (${target}); released versions are immutable. Bump the version.`);
  }
  fs.renameSync(src, target);
  fs.rmSync(tmp, { recursive: true, force: true });
  return `Packed ${target}\nsha256 ${sha256File(target)}`;
}

main().catch((e) => {
  if (e instanceof FactoryError) {
    console.error(`ERROR: ${e.message}`);
    for (const h of e.hints) console.error(`  hint: ${h}`);
  } else {
    console.error(`INTERNAL ERROR: ${e.stack || e}`);
  }
  process.exit(1);
});
