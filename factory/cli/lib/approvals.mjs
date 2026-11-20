// @ts-check
/**
 * Human approval tokens.
 *
 * Tokens are minted ONLY by the UserPromptSubmit hook from the literal text the human typed
 * (e.g. "/approve-phase"). Each record is HMAC-signed with a key stored outside the repo
 * (~/.game-factory/approval.key) that agents are forbidden to read. Gated CLI transitions and
 * the Playgama MCP guard verify the signature, the binding (game + gate + target hash), expiry,
 * and single use. A record whose target no longer matches (e.g. the spec changed after the
 * human approved it) is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, readJsonl, appendJsonl, hashTree, FactoryError, loadConfig, nowIso, ensureDir, TASK_ID_RE } from './core.mjs';

/** Gate commands: forward transitions that require a fresh human token. */
export const GATES = {
  'approve-concept': { describe: 'Approve the Game Concept Brief (freezes concept)' },
  'approve-spec': { describe: 'Approve the final game specification' },
  'start-development': { describe: 'Freeze spec and authorize implementation' },
  'approve-phase': { describe: 'Approve the current phase checkpoint' },
  'approve-playtest': { describe: 'Approve the release candidate after personal playtest' },
  'approve-release': { describe: 'Approve release (merge develop -> main, tag)' },
  'authorize-publish': { describe: 'Authorize one Playgama external operation' },
  'approve-spec-change': { describe: 'Approve an amended specification' },
  'retry-task': { describe: 'Grant extra attempts to a BLOCKED task' },
  'abandon-task': { describe: 'Abandon a BLOCKED task' },
  'abandon-game': { describe: 'Abandon a draft game (before development); then /archive-game' },
  'archive-game': { describe: 'Archive a released or abandoned game' },
};

/** Decision commands: recorded and signed for audit, no target binding. */
export const DECISIONS = ['reject-phase', 'request-changes', 'pause', 'resume', 'modify-requirements', 'reject-playtest'];

/** Playgama operations a human can authorize, mapped to the MCP tools each covers. */
export const PUBLISH_OPS = {
  draft: {
    multiUse: true,
    tools: ['create_application', 'update_application_form', 'start_archive_upload', 'confirm_archive_upload', 'start_cover_upload', 'confirm_cover_upload'],
    describe: 'Create/update the PRIVATE draft: application, form, build archive, covers',
  },
  'store-config': {
    multiUse: true,
    tools: ['replace_in_app_products', 'create_leaderboard', 'update_leaderboard'],
    describe: 'Change in-app product catalog / leaderboards (replace deletes omitted products)',
  },
  sandbox: { multiUse: false, tools: ['publish_sandbox'], describe: 'PUBLIC sandbox: anyone with the link can play; no moderation' },
  traffic: { multiUse: false, tools: ['start_sandbox_traffic'], describe: 'Start a traffic campaign (cannot be undone)' },
  'catalog-update': { multiUse: false, tools: ['send_playgama_catalog_update'], describe: 'Push a build to ALL live catalog players without moderation' },
  referral: { multiUse: false, tools: ['apply_referral_code'], describe: 'Apply a referral code to the organization' },
};

/** Every Playgama MCP tool that has side effects. Anything else is treated as read-only. */
export const PLAYGAMA_WRITE_TOOLS = new Set(Object.values(PUBLISH_OPS).flatMap((o) => o.tools));

export function opForTool(tool) {
  for (const [op, def] of Object.entries(PUBLISH_OPS)) if (def.tools.includes(tool)) return op;
  return null;
}

function getKey({ create = false } = {}) {
  const { keyFile } = paths();
  if (!fs.existsSync(keyFile)) {
    if (!create) throw new FactoryError('Approval key missing: no human approval has ever been recorded on this machine.');
    ensureDir(path.dirname(keyFile));
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}

function canonical(rec) {
  const { sig, ...rest } = rec;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function sign(rec, key) {
  return crypto.createHmac('sha256', key).update(canonical(rec)).digest('hex');
}

/** Called only from the UserPromptSubmit hook. */
export function mintRecord({ kind, command, game, target, args, prompt, sessionId }) {
  const key = getKey({ create: true });
  const rec = {
    v: 1,
    id: crypto.randomUUID(),
    ts: nowIso(),
    kind, // 'gate' | 'decision'
    command,
    game: game || null,
    target: target ?? null,
    args: args || {},
    prompt: String(prompt).slice(0, 2000),
    sessionId: sessionId || null,
  };
  rec.sig = sign(rec, key);
  appendJsonl(paths().approvals, rec);
  return rec;
}

export function verifySig(rec) {
  try {
    const key = getKey();
    const expected = sign(rec, key);
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(rec.sig || '', 'hex'));
  } catch {
    return false;
  }
}

function consumedIds() {
  return new Set(readJsonl(paths().consumed).map((c) => c.id));
}

/**
 * Find a valid token. Returns the record or null. Does not consume.
 * @param {{command:string, game:string, target?:string|null, op?:string, ttlHours?:number}} q
 */
export function findToken(q) {
  const cfg = loadConfig();
  const ttl = (q.ttlHours ?? cfg.approvalTtlHours) * 3600 * 1000;
  const used = consumedIds();
  const recs = readJsonl(paths().approvals).reverse();
  for (const r of recs) {
    if (r.kind !== 'gate' || r.command !== q.command || r.game !== q.game) continue;
    if (q.op && r.args?.op !== q.op) continue;
    if (Date.now() - Date.parse(r.ts) > ttl) continue;
    if (used.has(r.id)) continue;
    if (!verifySig(r)) continue;
    if (q.target !== undefined && r.target !== q.target) continue;
    return r;
  }
  return null;
}

export function consume(rec, by) {
  appendJsonl(paths().consumed, { id: rec.id, ts: nowIso(), by });
}

/**
 * Require and consume a token for a gated transition. Explains precisely what the human must
 * type when absent, and distinguishes "stale target" from "never approved".
 */
export function requireToken({ command, game, target, by }) {
  const rec = findToken({ command, game, target });
  if (rec) {
    consume(rec, by);
    return rec;
  }
  const anyRec = findToken({ command, game });
  if (anyRec) {
    throw new FactoryError(
      `Human approval "/${command}" exists for ${game} but it was given for a different state ` +
      `(approved target ${short(anyRec.target)}, current ${short(target)}). The artifact changed after approval; ` +
      'the human must review the current version and approve again.',
      [`Ask the user to review and type: /${command} ${game}`]);
  }
  throw new FactoryError(
    `No valid human approval for "/${command}" on game ${game}. Only the user can grant it by typing the command.`,
    [`Ask the user to type: /${command} ${game}`]);
}

function short(h) {
  return h ? String(h).slice(0, 24) : 'none';
}

/** Lightweight parse of a slash command line typed by the human. */
export function parseCommand(prompt, knownGames) {
  const m = String(prompt).trim().match(/^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const command = m[1];
  const isGate = Object.hasOwn(GATES, command);
  const isDecision = DECISIONS.includes(command);
  if (!isGate && !isDecision) return null;
  const rest = (m[2] || '').trim();
  const tokens = rest ? rest.split(/\s+/) : [];
  const args = {};
  const free = [];
  for (const [i, tok] of tokens.entries()) {
    // FX-15: the reason of /abandon-game is free text that may name another game ("superseded by other-game"),
    // so for that command only the FIRST word can select the game.
    if (!args.game && knownGames.includes(tok) && (command !== 'abandon-game' || i === 0)) args.game = tok;
    else if (command === 'authorize-publish' && !args.op && Object.hasOwn(PUBLISH_OPS, tok)) args.op = tok;
    else if (command === 'approve-release' && !args.version && /^v?\d+\.\d+\.\d+$/.test(tok)) args.version = tok.replace(/^v/, '');
    else if ((command === 'retry-task' || command === 'abandon-task') && !args.taskId && TASK_ID_RE.test(tok)) args.taskId = tok;
    else free.push(tok);
  }
  if (free.length) args.text = free.join(' ');
  return { command, kind: isGate ? 'gate' : 'decision', args };
}

/**
 * Compute what the human is approving *right now*, from authoritative state on disk.
 * The same function is used by the CLI at consumption time, so any drift is detected.
 */
export function computeTarget(command, state, args, gameRepo) {
  switch (command) {
    case 'approve-concept': return hashTree(`${gameRepo}/design/concept`);
    case 'approve-spec':
    case 'approve-spec-change': return hashTree(`${gameRepo}/design/spec`);
    case 'start-development': return state.hashes?.spec ?? null;
    case 'approve-phase': {
      const p = state.phases?.find((x) => x.n === state.currentPhase);
      return p?.checkpoint ? `phase-${p.n}@${p.checkpoint.evidence?.head ?? 'none'}` : `phase-${state.currentPhase ?? 'none'}@not-checkpointed`;
    }
    case 'approve-playtest': return state.rc?.sha ?? null;
    case 'approve-release': return `${state.rc?.sha ?? 'none'}#${args.version ?? '1.0.0'}`;
    case 'authorize-publish': return `${args.op ?? 'none'}@${state.release?.package?.sha256 ?? 'unpackaged'}`;
    case 'retry-task':
    case 'abandon-task': return `task:${args.taskId ?? 'none'}`;
    case 'abandon-game': return `abandon:${state.id}`;
    case 'archive-game': return `archive:${state.id}`;
    default: return null;
  }
}
