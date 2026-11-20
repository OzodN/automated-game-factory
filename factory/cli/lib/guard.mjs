// @ts-check
/**
 * Tool-call guard used by the PreToolUse hook. Returns a decision for one tool call:
 *   { decision: 'deny', reason }  — blocked
 *   { decision: null }             — no opinion (normal permission flow continues)
 * Side effects (provenance log, claim registration, token consumption) are applied by applyEffects().
 *
 * Defense in depth: the deterministic scope check in `factory task verify` is the real guarantee
 * for code isolation; this guard prevents accidents early and protects state, keys and approvals.
 *
 * Role checks use base roles: a `<agent>-retry` variant has exactly the permissions of `<agent>`.
 * Factory maintenance claims (`factory maint claim FX-NN`) are registered like task claims with
 * game `_factory`, so they get the same write scope (worktree + `.inbox/_factory/FX-NN/`).
 *
 * Claims are attempt-scoped (FX-02): a claim whose attempt was superseded by a newer `task start`, or that the
 * orchestrator released (`factory task release-claim`), grants no writes, blocks no new claim and does not
 * count towards the Agent concurrency cap (see claims.mjs).
 *
 * Shell commands (FX-05) are analysed per simple command (shell.mjs / shell-rules.mjs): text inside quotes,
 * heredoc bodies and commit messages is data; write rules look at real write TARGETS (sources of moves too). Fail
 * closed: the precise rules only RELAX the old text rules for lines that are fully understood (analyzeShell); any
 * other line gets the old rules (legacyShellDeny) plus the precise ones. The approval-key, `claude`, push and
 * destructive-git checks stay deliberately coarse (whole command text).
 *
 * Spec mode (FX-05, FD-01): asset-producer and qa-engineer write the single spec files the factory-spec playbook
 * assigns them (SPEC_OWNER_FILES) without a task claim, under the designers' mode rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, norm, samePathPrefix, appendJsonl, nowIso, loadConfig } from './core.mjs';
import { loadState, gameExists, getFocus, listGames } from './state.mjs';
import { PLAYGAMA_WRITE_TOOLS, opForTool, findToken, consume, PUBLISH_OPS } from './approvals.mjs';
import { FACTORY_AGENTS, BASE_AGENTS, baseRole, isFactoryAgent } from './agents.mjs';
import { loadMaint, MAINT_GAME } from './maint.mjs';
import { readAgentMap, recordClaim, claimState, claimEnded, liveAgents, liveHolder } from './claims.mjs';
import { analyzeShell, resolvePath, writeTargets, deleteTargets, cliInvocation, gitInfo, setsGitEnv, runsCode, WRITE_OR_SPAWN_HINT, copyMoveTokens } from './shell-rules.mjs';

export { FACTORY_AGENTS };
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/**
 * CLI subcommands every subagent may run (read-only; `assets search --remote` and `assets show <source:item>` too).
 * Help is allowed for every agent and every assets subcommand (FX-13): `assets`, `assets --help`,
 * `assets <cmd> --help` (the CLI returns the help text before running anything when --help is given).
 */
const ASSETS_HELP_CLI = /^assets(?:(?:\s+[a-z-]+)?\s+--help)?(?:\s+2>)?\s*$/;
const SUB_ALLOWED_CLI = [/^status\b/, /^help\b/, /^--help\s*$/, ASSETS_HELP_CLI, /^task (claim|show|next)\b/, /^plan validate\b/, /^assets (where|search|show|sources|pull|stats|help)\b/, /^decisions\b/, /^maint (claim|list|show)\b/, /^review (schema|check)\b/];
/** Asset library / remote index administration: asset-producer only. */
const ASSET_ADMIN_CLI = /^assets (ingest|verify|reindex|sync|acquire|preview|deny|find-live)\b/;
const ASSET_INDEX_DENY = 'The remote asset index (.cache/asset-index) is written only by the factory CLI (`factory assets sync`); it is rebuildable, never edit it by hand.';
/** Text match of a write target naming the remote asset index folder. */
const ASSET_INDEX_RE = /\.cache[\\/]+asset-index(?![A-Za-z0-9_-])/i;
/** Locations a tree delete may never name (text match; the configured absolute roots are matched too). */
const PROTECTED_RE = /(\.factory|asset-index|\.worktrees|\.inbox|[\\/]archive\b|[\\/]games\b|asset-library|\.game-factory|^games[\\/]|\sgames[\\/])/i;
/** A path segment `.factory` or `.inbox` (text match of a write target). */
const STATE_INBOX_RE = /(^|[^A-Za-z0-9_.-])\.(factory|inbox)(?![A-Za-z0-9_-])/i;
/**
 * Spec files a playbook owner (factory-spec skill) writes in spec mode without a task claim, under the same
 * mode rules as designers (CONCEPT_APPROVED / SPEC_DRAFT, or an open change request). Paths are relative to
 * `games/<g>/design/spec/`.
 */
export const SPEC_OWNER_FILES = { 'asset-producer': ['art-audio.md'], 'qa-engineer': ['test-plan.md'] };

/** True for a path inside the default remote asset index folder, or the GAME_ASSET_INDEX file and its journals. */
function inAssetIndex(file, p) {
  if (samePathPrefix(file, `${p.root}/.cache/asset-index`)) return true;
  if (!process.env.GAME_ASSET_INDEX) return false;
  const f = norm(file).toLowerCase();
  const idx = norm(process.env.GAME_ASSET_INDEX).toLowerCase();
  return f === idx || f.startsWith(`${idx}-`);
}

const deny = (reason) => ({ decision: 'deny', reason });
const none = (effects = []) => ({ decision: null, effects });
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;

const agentMap = readAgentMap;

/** Deny message for an agent whose claim ended (superseded attempt or released by the orchestrator). */
function endedClaimDeny(claim, st) {
  return deny(`Your claim of ${claim.task} (attempt ${claim.attempt ?? '?'}) is ${st.reason}. Stop working on it: write nothing more and finish; ` +
    'the orchestrator has dispatched (or will dispatch) a fresh agent.');
}

/** Parse "games/<g>/design/<area>/..." */
function designTarget(file) {
  const p = paths();
  if (!samePathPrefix(file, p.games)) return null;
  const rel = norm(file).slice(p.games.length + 1);
  const [g, top, area] = rel.split('/');
  return { game: g, top, area, rel };
}

function designWritable(file) {
  const d = designTarget(file);
  if (!d) return { ok: false, why: 'not a design path' };
  if (!gameExists(d.game)) return { ok: false, why: `game ${d.game} is not registered` };
  if (d.top !== 'design') return { ok: false, why: `game code lives in task worktrees only; ${d.rel} is outside design/ (use a task)` };
  const s = loadState(d.game);
  if (s.mode === 'ARCHIVED') return { ok: false, why: 'game archived' };
  if (s.mode === 'ABANDONED') return { ok: false, why: 'game abandoned (only /archive-game remains)' };
  const preDev = ['IDEATION', 'CONCEPT_APPROVED', 'SPEC_DRAFT'].includes(s.mode);
  if (d.area === 'concept') return s.mode === 'IDEATION' ? { ok: true } : { ok: false, why: 'the concept is approved and frozen' };
  if (d.area === 'spec') {
    if (s.mode === 'CONCEPT_APPROVED' || s.mode === 'SPEC_DRAFT') return { ok: true };
    if (s.openChangeRequest) return { ok: true };
    return { ok: false, why: `the specification is ${s.mode === 'IDEATION' ? 'not started (concept not approved)' : 'approved/frozen'}; changes need /modify-requirements` };
  }
  return preDev || s.openChangeRequest || ['research', 'tech'].includes(d.area) ? { ok: true } : { ok: false, why: 'design is frozen' };
}

/** @param {any} input hook JSON */
export function decide(input) {
  const p = paths();
  const cfg = loadConfig();
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const isSub = !!input.agent_id;
  const agentType = input.agent_type || 'main';
  const role = baseRole(agentType, cfg);

  // ------------------------------------------------ file writes
  if (FILE_TOOLS.has(tool)) {
    const raw = ti.file_path || ti.notebook_path;
    if (!raw) return none();
    const file = norm(path.isAbsolute(raw) ? raw : path.join(input.cwd || p.root, raw));
    if (samePathPrefix(file, p.state)) return deny('Factory state (.factory/) is written only by the factory CLI and hooks. Use `node factory/cli/factory.mjs ...`.');
    if (samePathPrefix(file, path.dirname(p.keyFile))) return deny('The approval key directory is off-limits to agents.');
    if (inAssetIndex(file, p)) return deny(ASSET_INDEX_DENY);
    if (samePathPrefix(file, p.archive)) return deny('archive/ is written only by `factory release package` / `factory gate archive-game` (released or abandoned games; a draft is abandoned first with `factory gate abandon-game` after /abandon-game).');
    const effect = { type: 'provenance', rec: { ts: nowIso(), agentId: input.agent_id || null, agentType: isSub ? agentType : 'game-orchestrator', tool, path: file.toLowerCase() } };

    if (isSub) {
      if (!BASE_AGENTS.has(role)) return deny(`Subagent type "${agentType}" is not a factory agent and may not write files.`);
      if (samePathPrefix(file, p.inbox) && /[\\/]publication[\\/]covers([\\/]|$)/i.test(file)) {
        return deny('Publication covers are produced only by `factory publish covers` (the orchestrator runs it); agents never write into publication/covers/. Reference the produced files in packet.json.');
      }
      const claim = agentMap().agents?.[input.agent_id];
      const inClaim = claim?.task && (samePathPrefix(file, claim.worktree) || samePathPrefix(file, `${p.inbox}/${claim.game}/${claim.task}`));
      if (inClaim) {
        const st = claimState(claim);
        if (claimEnded(st)) return endedClaimDeny(claim, st);
        if (samePathPrefix(file, `${p.inbox}/${claim.game}/${claim.task}`) && /review-a\d+\.json$/i.test(file)) return deny('Implementers cannot write review files.');
        return none([effect]);
      }
      if (FACTORY_AGENTS.reviewers.includes(role) && samePathPrefix(file, p.inbox) && /[\\/]review-a\d+\.json$/i.test(file)) return none([effect]);
      if (role === 'qa-engineer' && samePathPrefix(file, p.inbox) && /[\\/]qa[\\/]/i.test(file)) return none([effect]);
      if (FACTORY_AGENTS.designers.includes(role)) {
        if (samePathPrefix(file, p.games)) {
          const w = designWritable(file);
          return w.ok ? none([effect]) : deny(`Design write refused: ${w.why}.`);
        }
        if (role === 'tech-architect' && samePathPrefix(file, p.inbox) && /[\\/]plan[\\/]/i.test(file)) return none([effect]);
      }
      if (role === 'release-manager' && samePathPrefix(file, p.inbox) && /[\\/](publication|release)[\\/]/i.test(file)) return none([effect]);
      if (role === 'asset-producer' && samePathPrefix(file, p.inbox) && /[\\/]assets[\\/]/i.test(file)) return none([effect]);
      // FD-01: spec-mode owners of single spec files (factory-spec playbook) write them without a task claim.
      const ownFiles = /** @type {Record<string, string[]>} */ (SPEC_OWNER_FILES)[role];
      if (ownFiles && samePathPrefix(file, p.games)) {
        const d = designTarget(file);
        const specFile = d && d.top === 'design' && d.area === 'spec' ? d.rel.split('/').slice(3).join('/').toLowerCase() : null;
        if (specFile && ownFiles.includes(specFile)) {
          const w = designWritable(file);
          return w.ok ? none([effect]) : deny(`Spec write refused: ${w.why}.`);
        }
        if (!claim?.task) {
          return deny(`${agentType} writes only ${ownFiles.map((f) => `design/spec/${f}`).join(', ')} without a task (factory-spec playbook, spec mode or an open change request); ${file} is not one of them.`);
        }
      }
      if (FACTORY_AGENTS.implementers.includes(role) && !claim?.task) {
        return deny('No task claimed. Your first action must be `node factory/cli/factory.mjs task claim <TASK-ID> --game <game>` (factory maintenance: `maint claim <FX-ID>`); then write only inside that worktree.');
      }
      return deny(`${agentType} may not write ${file}. Allowed: your claimed task worktree and its inbox report file.`);
    }
    // main thread (orchestrator)
    if (samePathPrefix(file, p.worktrees)) return deny('The orchestrator does not write game code; dispatch an implementer task (worktrees belong to task agents).');
    if (samePathPrefix(file, p.games)) {
      const w = designWritable(file);
      return w.ok ? none([effect]) : deny(`Write refused: ${w.why}.`);
    }
    return none([effect]);
  }

  // ------------------------------------------------ shell
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command || '');
    if (/\.game-factory|approval\.key/i.test(cmd)) return deny('Commands may not reference the approval key.');
    if (/(^|[\s;&|(`])claude(\.exe|\.cmd)?(\s|$)/.test(cmd)) return deny('Agents may not launch Claude Code sessions (that could forge human input). Ask the user.');
    if (/\bgit\b[^\n]*\b(push|filter-branch|filter-repo|update-ref)\b/.test(cmd)) return deny('git push / history rewriting is not permitted (local-only repos; no history rewrites).');
    if (/\bgit\b[^\n]*\b(reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+-D|tag\s+-d|worktree\s+(remove|prune)|stash\s+(drop|clear))\b/.test(cmd)) {
      return deny('Destructive git operation blocked (would discard work). Preserve history; ask the orchestrator/human.');
    }
    // Simple commands with the directory each runs in (FX-05): quoted strings, heredoc bodies and commit
    // messages are data. The precise rules below may only RELAX the old text rules for lines the guard fully
    // understands; for any other line the old rules (legacyShellDeny) apply unchanged, plus the precise ones.
    let cmds;
    let understood;
    try {
      ({ cmds, understood } = analyzeShell(cmd, { dialect: tool === 'PowerShell' ? 'powershell' : 'bash', cwd: input.cwd ? norm(input.cwd) : p.root }));
    } catch (e) {
      return deny(`The guard could not analyse this command (${/** @type {any} */ (e).message}); split it into simpler commands.`);
    }
    const ROOTS = [p.state, p.worktrees, p.inbox, p.archive, p.games];
    if (!understood) {
      const legacy = legacyShellDeny(cmd, input, p, isSub);
      if (legacy) return legacy;
      // A shell / interpreter / xargs / find -exec on a line that mentions .factory/.inbox with any write or
      // spawn indicator: the code it runs (from a string, pipe or heredoc) cannot be judged, so refuse.
      if (runsCode(cmds) && (STATE_INBOX_RE.test(cmd) || mentions(cmd, p.state, p.inbox)) && WRITE_OR_SPAWN_HINT.test(cmd)) {
        return deny('Shell writes into .factory/ or .inbox/ are not allowed; use the Write tool (tracked provenance) or the factory CLI. ' +
          '(A shell or interpreter on this line runs code the guard cannot inspect; write the file with the Write tool or split the command.)');
      }
    }
    // Integration/release worktrees: the old text rule always applies (an unknown directory must not slip through).
    if (legacyIntegrationDeny(cmd)) return deny('Integration/release worktrees are operated only by the factory CLI.');
    // Tree deletes (rm -r, Remove-Item, rmdir, rd, del, find -delete) whose targets name a protected location.
    const protectedDelete = (c) => deleteTargets(c).some((w) => PROTECTED_RE.test(w.v) || PROTECTED_RE.test(w.raw) || mentions(w.v, ...ROOTS) || mentions(w.raw, ...ROOTS));
    if (cmds.some((c) => protectedDelete(c) && !(isSub && mentionsOwnWorktreeOnly(deleteTargets(c).map((w) => w.v).join(' '), input)))) {
      return deny('Deleting factory state, game repos, worktrees, inbox, archive or the asset library is not permitted (use paths relative to your worktree).');
    }
    // Real writes whose TARGET is inside .factory/ or .inbox/: redirections (never 2>&1, >&2, 2>/dev/null, >NUL),
    // tee / Out-File / Set-Content / Add-Content, cp / mv / Copy-Item / Move-Item / rsync / tar -x -C destinations,
    // sed -i, New-Item, mkdir, touch, rm, inline `node -e` scripts with fs write calls. Reads stay free.
    const intoStateOrInbox = (w, dir) => {
      if (STATE_INBOX_RE.test(w.v) || STATE_INBOX_RE.test(w.raw) || mentions(w.v, p.state, p.inbox) || mentions(w.raw, p.state, p.inbox)) return true;
      const abs = resolvePath(w.v, dir);
      return !!abs && (samePathPrefix(abs, p.state) || samePathPrefix(abs, p.inbox));
    };
    if (cmds.some((c) => writeTargets(c).some((w) => intoStateOrInbox(w, c.dir)))) {
      return deny('Shell writes into .factory/ or .inbox/ are not allowed; use the Write tool (tracked provenance) or the factory CLI.');
    }
    const intoAssetIndex = (w, dir) => {
      if (ASSET_INDEX_RE.test(w.v) || ASSET_INDEX_RE.test(w.raw)) return true;
      const abs = resolvePath(w.v, dir);
      return !!abs && inAssetIndex(abs, p);
    };
    if (cmds.some((c) => writeTargets(c).some((w) => intoAssetIndex(w, c.dir)))) return deny(ASSET_INDEX_DENY);
    // Copy/move class, closed as a class: any non-exempt token naming .factory/.inbox anywhere in its text, or any
    // write-capable token that does not resolve outside them while the command runs inside them.
    if (cmds.some((c) => copyMoveDenied(c, p))) {
      return deny('Shell copies/moves into or out of .factory/ or .inbox/ are refused unless the protected path is the plain first source of a copy (`cp <src> <outside-dst>`); use the Write tool or the factory CLI.');
    }
    const gits = /** @type {{c: any, g: NonNullable<ReturnType<typeof gitInfo>>}[]} */ (cmds.map((c) => ({ c, g: gitInfo(c) })).filter((x) => x.g?.write));
    if (gits.some(({ c, g }) => [effectiveGitDir(c, g), ...g.C].some((d) => d && /[\\/]_(integration|release-)/.test(d)))) {
      return deny('Integration/release worktrees are operated only by the factory CLI.');
    }
    if (isSub) {
      // Subagents change repositories only inside their own claimed worktree (never the factory checkout or main).
      const gitDenied = gitWriteCheck(gits, cmds, input);
      if (gitDenied) return gitDenied;
      // Only `node <...>factory/cli/factory.mjs <args>` runs the CLI; cat/grep/git diff of the file are reads.
      for (const c of cmds) {
        const sub = cliInvocation(c);
        if (sub === null) continue;
        if (ASSET_ADMIN_CLI.test(sub) && role === 'asset-producer') continue;
        if (!SUB_ALLOWED_CLI.some((re) => re.test(sub))) return deny(`Only the orchestrator may run "factory ${sub.split(' ').slice(0, 2).join(' ')}". Report back instead.`);
        const claimM = sub.match(/^task claim\s+([A-Z0-9-]+)(?:.*--game\s+([a-z0-9-]+))?/);
        if (claimM) return registerClaim(input, claimM[1], claimM[2]);
        const maintM = sub.match(/^maint claim\s+([A-Za-z0-9-]+)/);
        if (maintM) return registerMaintClaim(input, maintM[1]);
      }
    }
    return none();
  }

  // ------------------------------------------------ Playgama MCP
  if (typeof tool === 'string' && tool.startsWith('mcp__') && /playgama/i.test(tool)) {
    const name = tool.split('__').pop();
    if (!PLAYGAMA_WRITE_TOOLS.has(name)) {
      if (/^(create|update|replace|start|confirm|publish|send|apply|delete|remove|submit)_/.test(name)) {
        return deny(`Playgama tool "${name}" looks state-changing but is not in the factory's known op map; refusing until the op map is reviewed (factory/cli/lib/approvals.mjs).`);
      }
      return none();
    }
    if (isSub && role !== 'release-manager') return deny('Only release-manager (or the orchestrator) may call Playgama write tools.');
    const op = opForTool(name);
    const g = getFocus();
    if (!g || !gameExists(g)) return deny('No focused game; Playgama operations are bound to a game (factory game focus <id>).');
    const s = loadState(g);
    const target = `${op}@${s.release?.package?.sha256 ?? 'unpackaged'}`;
    const def = PUBLISH_OPS[op];
    const tok = findToken({ command: 'authorize-publish', game: g, op, target, ttlHours: def.multiUse ? cfg.draftTokenTtlHours : undefined });
    if (!tok) {
      return deny(`Playgama "${name}" requires human authorization of op "${op}" (${def.describe}) for ${g} build ${String(s.release?.package?.sha256 || 'unpackaged').slice(0, 12)}. ` +
        `Explain the consequences to the user and ask them to type: /authorize-publish ${op} ${g}`);
    }
    return none(def.multiUse ? [{ type: 'log', rec: { ts: nowIso(), kind: 'publish-use', op, tool: name, token: tok.id, game: g } }] : [{ type: 'consume', rec: tok, by: `mcp:${name}` }]);
  }

  // ------------------------------------------------ subagent spawning (main thread)
  if (tool === 'Agent' || tool === 'Task') {
    const st = typeof ti.subagent_type === 'string' ? ti.subagent_type : '';
    if (st && isFactoryAgent(st, cfg) && (has(ti, 'model') || has(ti, 'effort'))) {
      return deny(`Factory agents run on pinned models: "${st}" has its model and effort fixed in .claude/agents/${st}.md (table: factory/config.json "models"). ` +
        'Repeat the call without "model" and "effort". For attempts >= 2 dispatch the "-retry" agent printed as "Dispatch to" by `factory task start`.');
    }
    const cap = cfg.maxActiveAgents ?? 4;
    const active = liveAgents().length;
    if (active >= cap) {
      return deny(`Agent concurrency cap reached (${active}/${cap} active). Wait for a running agent to finish (you will be notified). ` +
        'If an agent was stopped mid-attempt: `factory task release-claim <id>`; stale entries: `factory recover --apply`.');
    }
    return none();
  }
  return none();
}

/** `.factory` / `.inbox` anywhere in a token (option bundles such as `-t.inbox/g` included). */
const STATE_INBOX_ANY_RE = /\.(factory|inbox)(?![A-Za-z0-9_-])/i;
/** Flag-only option tokens that cannot carry a path value. */
const PURE_FLAG_RE = /^(-[rRfinvpaulsLPHx]+|--(recursive|force|verbose|archive|update|no-clobber|interactive|parents)|-(Recurse|Force|Container|PassThru))$/i;

/**
 * Copy/move class rule (see shell-rules.mjs copyMoveTokens).
 * @param {any} c command @param {ReturnType<typeof paths>} p
 */
function copyMoveDenied(c, p) {
  const cm = copyMoveTokens(c);
  if (!cm) return false;
  const named = (w) => STATE_INBOX_ANY_RE.test(w.v) || STATE_INBOX_ANY_RE.test(w.raw) || mentions(w.v, p.state, p.inbox) || mentions(w.raw, p.state, p.inbox);
  const checked = cm.tokens.filter((w) => !cm.exempt.includes(w));
  if (checked.some(named)) return true;
  const inProtected = !!c.dir && (samePathPrefix(c.dir, p.state) || samePathPrefix(c.dir, p.inbox) || STATE_INBOX_ANY_RE.test(c.dir));
  if (!inProtected) return false;
  return checked.some((w) => {
    if (/^-/.test(w.v)) return !PURE_FLAG_RE.test(w.v);
    const abs = resolvePath(w.v, c.dir);
    return !abs || samePathPrefix(abs, p.state) || samePathPrefix(abs, p.inbox) || STATE_INBOX_ANY_RE.test(abs);
  });
}

/** Also match the configured absolute locations (they may be relocated via env). */
function mentions(text, ...dirs) {
  const low = String(text).replace(/\\/g, '/').toLowerCase();
  return dirs.some((d) => low.includes(d.toLowerCase()) || low.includes(d.toLowerCase().replace(/^([a-z]):/, '/$1')));
}

// ------------------------------------------------ old (pre-FX-05) shell rules: the fail-closed fallback

const LEGACY_SPLIT = /&&|\|\||;|\||\n/;
const LEGACY_GIT_WRITE = /\bgit\b[^\n]*\b(commit|merge|checkout|switch|rebase|cherry-pick|revert|am|reset|restore)\b/;
/** Old subcommand-position matcher of git writes (group 1 = global options, group 2 = subcommand). */
const LEGACY_GIT_WRITE_SUBCMD = /^git(?:\.exe)?((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+(commit|merge|rebase|cherry-pick|revert|am|reset|restore|checkout|switch|stash|add|rm|mv|apply|pull|clean)(?=\s|$)/;
const LEGACY_CD_RE = /^(?:cd|pushd|chdir|Set-Location|sl)(?:\s+(.*))?$/i;
const LEGACY_POPD_RE = /^(?:popd|Pop-Location)\b/i;

/** The old integration/release rule (text based). @param {string} cmd */
function legacyIntegrationDeny(cmd) {
  const segs = cmd.split(LEGACY_SPLIT).map((x) => x.trim());
  return segs.some((sg) => /[\\/]_(integration|release-)/.test(sg) && LEGACY_GIT_WRITE.test(sg)) ||
    (/\bcd\s+"?[^&;\n]*[\\/]_(integration|release-)/.test(cmd) && LEGACY_GIT_WRITE.test(cmd));
}

/** Old cd/-C target resolution (text based). @param {string} raw @param {string|null} dir */
function legacyResolveDir(raw, dir) {
  const t = String(raw || '').trim().replace(/^(?:\/d\s+|-(?:LiteralPath|Path)\s+)/i, '').trim();
  return resolvePath(t, dir);
}

/**
 * The guard's text rules from before FX-05, applied unchanged to every command line the parser does not fully
 * understand: protected-location deletes, any segment that mentions .factory/.inbox together with a write-ish
 * token, the factory CLI path rule for subagents (every occurrence) and the segment-based git write check.
 * @returns {{decision: string, reason: string} | null}
 */
function legacyShellDeny(cmd, input, p, isSub) {
  const segs = cmd.split(LEGACY_SPLIT).map((x) => x.trim());
  const ROOTS = [p.state, p.worktrees, p.inbox, p.archive, p.games];
  if (segs.some((sg) => /(\brm\s+-[a-zA-Z]*r|Remove-Item|\brmdir\b|\brd\s|\bdel\s)/i.test(sg) && (PROTECTED_RE.test(sg) || mentions(sg, ...ROOTS)) &&
    !(isSub && mentionsOwnWorktreeOnly(sg, input)))) {
    return deny('Deleting factory state, game repos, worktrees, inbox, archive or the asset library is not permitted (use paths relative to your worktree).');
  }
  if (segs.some((sg) => (/(\.factory|\.inbox)/.test(sg) || mentions(sg, p.state, p.inbox)) && /(>|\btee\b|Set-Content|Out-File|Add-Content|\bcp\b|\bmv\b|Copy-Item|Move-Item|New-Item|sed\s+-i|writeFile)/i.test(sg))) {
    return deny('Shell writes into .factory/ or .inbox/ are not allowed; use the Write tool (tracked provenance) or the factory CLI.');
  }
  if (!isSub) return null;
  for (const m of cmd.matchAll(/factory[\\/]cli[\\/]factory\.mjs"?\s+([^\n;&|]*)/g)) {
    const sub = m[1].trim();
    if (ASSET_ADMIN_CLI.test(sub) && baseRole(input.agent_type || '') === 'asset-producer') continue;
    if (!SUB_ALLOWED_CLI.some((re) => re.test(sub))) return deny(`Only the orchestrator may run "factory ${sub.split(' ').slice(0, 2).join(' ')}". Report back instead.`);
  }
  /** @type {string|null} */
  let dir = input.cwd ? norm(input.cwd) : p.root;
  let claim;
  for (const raw of segs) {
    const sg = raw.replace(/^[({\s]+/, '').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    const cd = sg.match(LEGACY_CD_RE);
    if (cd) { dir = legacyResolveDir(cd[1] || '', dir); continue; }
    if (LEGACY_POPD_RE.test(sg)) { dir = null; continue; }
    const g = sg.match(LEGACY_GIT_WRITE_SUBCMD);
    if (!g) continue;
    let eff = dir;
    for (const c of (g[1] || '').matchAll(/-C\s+("[^"]*"|'[^']*'|\S+)/g)) eff = legacyResolveDir(c[1], eff);
    if (claim === undefined) claim = agentMap().agents?.[input.agent_id] || null;
    if (claim?.worktree) {
      const st = claimState(claim);
      if (claimEnded(st)) return endedClaimDeny(claim, st);
    }
    if (!claim?.worktree) {
      return deny(`Only an implementer with a claimed worktree may run git write commands ("git ${g[2]}"). Read-only git (diff, show, log, status) is unaffected.`);
    }
    if (!eff || !samePathPrefix(eff, claim.worktree)) {
      return deny(`"git ${g[2]}" must run inside your claimed worktree: \`cd "${claim.worktree}" && git ...\` (effective directory: ${eff || 'unknown'}). The factory checkout and main are merged only by the orchestrator.`);
    }
  }
  if (/\bgit\b[^\n]*\b(checkout|switch)\s+(main|develop)\b/.test(cmd)) return deny('Task agents stay on their task branch.');
  return null;
}

/** Directory a git command acts on: its run directory, then each `-C <path>` applied in order. */
function effectiveGitDir(c, g) {
  let eff = c.dir;
  for (const d of g.C) eff = resolvePath(d, eff);
  return eff;
}

/**
 * Effective-directory check for git write commands of subagents. The directory comes from the hook input
 * `cwd` (or the factory root) through cd/pushd/Set-Location and `git -C` (shell-rules.mjs), and a write is
 * allowed only when that directory is known and inside the agent's claimed worktree (path-prefix with a
 * separator, so FX-1 never matches FX-10). `--git-dir`, `--work-tree`, `GIT_DIR=` and `GIT_WORK_TREE=` would
 * point git elsewhere and are refused outright. Read-only git (diff, show, log, status, merge-base,
 * stash list/show, clean -n) is never affected.
 * @param {{c: any, g: NonNullable<ReturnType<typeof gitInfo>>}[]} gits git write commands
 * @param {any[]} cmds all commands of the line
 * @returns {{decision: string, reason: string} | null}
 */
function gitWriteCheck(gits, cmds, input) {
  if (!gits.length) return null;
  const redirect = gits.find(({ g }) => g.gitDir || g.workTree);
  if (redirect || setsGitEnv(cmds)) {
    return deny(`git write commands may not use --git-dir, --work-tree, GIT_DIR or GIT_WORK_TREE ("git ${(redirect?.g ?? gits[0].g).sub}"). ` +
      'Run plain git inside your claimed worktree: `cd "<worktree>" && git ...`.');
  }
  const claim = agentMap().agents?.[input.agent_id] || null;
  if (claim?.worktree) {
    const st = claimState(claim);
    if (claimEnded(st)) return endedClaimDeny(claim, st);
  }
  for (const { c, g } of gits) {
    if (!claim?.worktree) {
      return deny(`Only an implementer with a claimed worktree may run git write commands ("git ${g.sub}"). Read-only git (diff, show, log, status) is unaffected.`);
    }
    const eff = effectiveGitDir(c, g);
    if (!eff || !samePathPrefix(eff, claim.worktree)) {
      return deny(`"git ${g.sub}" must run inside your claimed worktree: \`cd "${claim.worktree}" && git ...\` (effective directory: ${eff || 'unknown'}). The factory checkout and main are merged only by the orchestrator.`);
    }
    if ((g.sub === 'checkout' || g.sub === 'switch') && g.args.some((w) => /^(main|develop)$/.test(w.v))) return deny('Task agents stay on their task branch.');
  }
  return null;
}

/** True when every absolute path in a delete segment lies inside the agent's own claimed worktree. */
function mentionsOwnWorktreeOnly(sg, input) {
  const claim = agentMap().agents?.[input.agent_id];
  if (!claim?.worktree || claimEnded(claimState(claim))) return false;
  const abs = sg.match(/([A-Za-z]:[\\/][^\s"']+|\/[^\s"']+)/g) || [];
  return abs.length > 0 && abs.every((a) => samePathPrefix(a, claim.worktree) && norm(a) !== norm(claim.worktree));
}

/** Live holder of the task's current attempt (superseded and released claims never block). */
function activeHolder(input, game, task) {
  return liveHolder(game, task, input.agent_id);
}

function registerClaim(input, taskId, gameArg) {
  const g = gameArg || getFocus();
  if (!g || !gameExists(g)) return deny(`Unknown game for claim (${g}). Pass --game <id>.`);
  const s = loadState(g);
  const t = s.tasks[taskId];
  if (!t) return deny(`Unknown task ${taskId} in ${g}.`);
  if (t.status !== 'IN_PROGRESS') return deny(`${taskId} is ${t.status}, not IN_PROGRESS; the orchestrator must start it first.`);
  // The attempt records its dispatch agent: the base agent on attempt 1, `<agent>-retry` on attempts >= 2.
  const n = t.attempts.length;
  const expected = t.attempts[n - 1]?.agent || t.agent;
  if (input.agent_type !== expected) {
    return deny(`${taskId} attempt ${n} must be executed by ${expected} (the "Dispatch to" agent of \`factory task start\`), not ${input.agent_type}.`);
  }
  const holder = activeHolder(input, g, taskId);
  if (holder) return deny(`${taskId} is already claimed by active agent ${holder}.`);
  return none([{ type: 'claim', agentId: input.agent_id, rec: { game: g, task: taskId, worktree: t.worktree, attempt: n, agentType: input.agent_type, claimedAt: nowIso() } }]);
}

/** `factory maint claim FX-NN`: only the recorded agent type; scope = maintenance worktree + its inbox folder. */
function registerMaintClaim(input, id) {
  const it = loadMaint()[id];
  if (!it) return deny(`Unknown factory maintenance item ${id}.`);
  if (it.status !== 'STARTED') return deny(`${id} is ${it.status}; nothing to claim.`);
  if (input.agent_type !== it.agent) return deny(`${id} is assigned to ${it.agent}, not ${input.agent_type}.`);
  const holder = activeHolder(input, MAINT_GAME, id);
  if (holder) return deny(`${id} is already claimed by active agent ${holder}.`);
  return none([{ type: 'claim', agentId: input.agent_id, rec: { game: MAINT_GAME, task: id, worktree: it.worktree, attempt: it.attempt ?? 1, agentType: input.agent_type, claimedAt: nowIso() } }]);
}

export function applyEffects(effects) {
  const p = paths();
  for (const e of effects || []) {
    if (e.type === 'provenance') appendJsonl(p.provenance, e.rec);
    else if (e.type === 'log') appendJsonl(p.hookLog, e.rec);
    else if (e.type === 'consume') consume(e.rec, e.by);
    else if (e.type === 'claim') recordClaim(e.agentId, e.rec);
  }
}

export function logDecision(input, result) {
  if (result.decision !== 'deny') return;
  appendJsonl(paths().hookLog, {
    ts: nowIso(), kind: 'deny', tool: input.tool_name, agentType: input.agent_type || 'main', agentId: input.agent_id || null,
    reason: result.reason, input: JSON.stringify(input.tool_input || {}).slice(0, 400),
  });
}

export { listGames };
