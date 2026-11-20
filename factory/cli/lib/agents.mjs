// @ts-check
/**
 * Factory agent roster, role mapping and pinned models.
 *
 * The pinning table lives in factory/config.json ("models"): it is the single source of truth.
 * .claude/agents/*.md carry the pins in their frontmatter; the base definitions are normalized and
 * the `<agent>-retry` variants are generated from them by factory/cli/gen-agent-models.mjs.
 * `factory doctor` and factory/cli/test/fx-models.test.mjs fail when a definition drifts.
 *
 * Dispatch rule: attempt 1 of a task runs as its base agent; attempts >= 2 run as `<agent>-retry`
 * when a retry variant exists (otherwise the base agent). No model/effort is ever passed on an Agent call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, loadConfig } from './core.mjs';

/** Base roles. A `<base>-retry` variant always has the permissions of its base role. */
export const FACTORY_AGENTS = {
  implementers: ['game-developer', 'platform-engineer', 'asset-producer', 'qa-engineer', 'tech-architect'],
  reviewers: ['code-reviewer', 'qa-engineer', 'tech-architect'],
  designers: ['game-designer', 'market-analyst', 'tech-architect'],
  release: ['release-manager'],
};
export const ORCHESTRATOR = 'game-orchestrator';
export const BASE_AGENTS = new Set([...Object.values(FACTORY_AGENTS).flat(), ORCHESTRATOR]);
export const RETRY_SUFFIX = '-retry';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Environment variables that override frontmatter model/effort for every subagent. */
export const MODEL_ENV_OVERRIDES = ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'];

/**
 * @param {any} [cfg]
 * @returns {{pins: Record<string, {model: string, effort: string}>, retry: {model: string, effort: string, agents: string[]} | null, unpinned: string[]}}
 */
export function modelTable(cfg = loadConfig()) {
  const m = cfg?.models || {};
  return { pins: m.pins || {}, retry: m.retry || null, unpinned: m.unpinned || [] };
}

/** Base agents that have a generated `-retry` variant. */
export function retryBases(cfg = loadConfig()) {
  return modelTable(cfg).retry?.agents || [];
}

export const retryName = (base) => `${base}${RETRY_SUFFIX}`;

/**
 * `game-developer-retry` -> `game-developer` for configured variants; anything else unchanged.
 * Without a `models.retry` table in the config (missing or partial config), any `<base>-retry` of a known
 * factory agent maps to its base, so its role permissions and the model/effort ban still apply.
 */
export function baseRole(agentType, cfg = loadConfig()) {
  if (typeof agentType !== 'string' || !agentType.endsWith(RETRY_SUFFIX)) return agentType;
  const base = agentType.slice(0, -RETRY_SUFFIX.length);
  const configured = modelTable(cfg).retry;
  if (configured) return retryBases(cfg).includes(base) ? base : agentType;
  return BASE_AGENTS.has(base) ? base : agentType;
}

/** True for every factory agent definition, including `-retry` variants. */
export function isFactoryAgent(agentType, cfg = loadConfig()) {
  return BASE_AGENTS.has(baseRole(agentType, cfg));
}

/** True when both agent types share a base role (e.g. game-developer and game-developer-retry). */
export function sameBaseRole(a, b, cfg = loadConfig()) {
  return baseRole(a, cfg) === baseRole(b, cfg);
}

/** The agent that must execute attempt `attempt` of a task assigned to `base`. */
export function dispatchAgent(base, attempt, cfg = loadConfig()) {
  return attempt >= 2 && retryBases(cfg).includes(base) ? retryName(base) : base;
}

/** Pinned {model, effort} of an agent type, or null when unpinned/unknown. */
export function pinFor(agentType, cfg = loadConfig()) {
  const t = modelTable(cfg);
  const base = baseRole(agentType, cfg);
  if (base !== agentType && t.retry) return { model: t.retry.model, effort: t.retry.effort };
  return t.pins[agentType] || null;
}

// ---------------------------------------------------------------- agent definition files

export const agentsDir = () => `${paths().root}/.claude/agents`;

/**
 * Split an agent definition into ordered frontmatter fields and body.
 * Fields are `key: value` lines; values are kept verbatim (quoted or not).
 * @param {string} text
 * @returns {{fields: Array<[string|null, string]>, body: string} | null}
 */
export function parseAgentFile(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  /** @type {Array<[string|null, string]>} */
  const fields = m[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return i > 0 && /^[A-Za-z][\w-]*$/.test(line.slice(0, i).trim()) ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : [null, line];
  });
  return { fields, body: m[2] };
}

/** @param {Array<[string|null, string]>} fields @param {string} key */
export function fieldValue(fields, key) {
  const f = fields.find(([k]) => k === key);
  return f ? unquote(f[1]) : undefined;
}

function unquote(v) {
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v; } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** @param {Array<[string|null, string]>} fields @param {string} body */
export function renderAgentFile(fields, body) {
  return `---\n${fields.map(([k, v]) => (k === null ? v : `${k}: ${v}`)).join('\n')}\n---\n${body}`;
}

/** Replace model/effort lines with the pin (appended at the end of the frontmatter), or drop them when unpinned. */
function withPin(fields, pin) {
  const kept = fields.filter(([k]) => k !== 'model' && k !== 'effort');
  return pin ? [...kept, ['model', pin.model], ['effort', pin.effort]] : kept;
}

export function retryDescription(base) {
  return `Retry variant of ${base} (pinned Opus). Use ONLY for attempts >= 2 of a task assigned to ${base}, i.e. when factory task start prints Dispatch to: ${retryName(base)}. Same instructions and tools as ${base}.`;
}

/**
 * Expected content of a base definition (pins applied) and of its retry variant, derived from the
 * ACTUAL base file text. Variants depend on the actual base body/tools, so editing a base without
 * regenerating its variant is detected.
 * @param {string} name base agent name
 * @param {string} text actual content of `<name>.md`
 * @param {any} [cfg]
 */
export function expectedFor(name, text, cfg = loadConfig()) {
  const t = modelTable(cfg);
  const parsed = parseAgentFile(text);
  if (!parsed) return { base: null, retry: null, error: `${name}.md has no frontmatter` };
  const basePin = t.unpinned.includes(name) ? null : t.pins[name] || null;
  const base = renderAgentFile(withPin(parsed.fields, basePin), parsed.body);
  let retry = null;
  if (t.retry && t.retry.agents.includes(name)) {
    const fields = withPin(parsed.fields, { model: t.retry.model, effort: t.retry.effort }).map(([k, v]) => {
      if (k === 'name') return /** @type {[string, string]} */ (['name', retryName(name)]);
      if (k === 'description') return /** @type {[string, string]} */ (['description', JSON.stringify(retryDescription(name))]);
      return /** @type {[string|null, string]} */ ([k, v]);
    });
    retry = renderAgentFile(fields, parsed.body);
  }
  return { base, retry, error: null };
}

/** Problems with the pinning table itself. */
export function checkTable(cfg = loadConfig()) {
  const t = modelTable(cfg);
  const out = [];
  if (!Object.keys(t.pins).length) out.push('factory/config.json has no "models.pins" table');
  for (const [name, pin] of Object.entries(t.pins)) {
    if (!BASE_AGENTS.has(name)) out.push(`pinned agent "${name}" is not a factory agent`);
    if (!pin?.model) out.push(`${name}: pin has no model`);
    if (!EFFORT_LEVELS.includes(pin?.effort)) out.push(`${name}: effort "${pin?.effort}" not in ${EFFORT_LEVELS.join('|')}`);
  }
  for (const name of BASE_AGENTS) if (!t.pins[name] && !t.unpinned.includes(name)) out.push(`${name} is neither pinned nor listed as unpinned`);
  if (t.retry) {
    if (!t.retry.model) out.push('models.retry has no model');
    if (!EFFORT_LEVELS.includes(t.retry.effort)) out.push(`models.retry effort "${t.retry.effort}" not in ${EFFORT_LEVELS.join('|')}`);
    for (const b of t.retry.agents || []) if (!t.pins[b]) out.push(`retry base "${b}" is not pinned`);
  }
  return out;
}

/**
 * Compare every agent definition with the pinning table.
 * @param {string} [dir] directory with the agent definitions
 * @param {any} [cfg]
 * @returns {{pins: string[], variants: string[], pinned: number, variantCount: number}}
 */
export function checkAgentDefinitions(dir = agentsDir(), cfg = loadConfig()) {
  const t = modelTable(cfg);
  const pins = checkTable(cfg);
  const variants = [];
  const names = [...new Set([...Object.keys(t.pins), ...t.unpinned])];
  for (const name of names) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) { pins.push(`${name}.md missing`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseAgentFile(text);
    if (!parsed) { pins.push(`${name}.md has no frontmatter`); continue; }
    const model = fieldValue(parsed.fields, 'model');
    const effort = fieldValue(parsed.fields, 'effort');
    const pin = t.unpinned.includes(name) ? null : t.pins[name];
    if (fieldValue(parsed.fields, 'name') !== name) pins.push(`${name}.md: name is "${fieldValue(parsed.fields, 'name')}"`);
    if (!pin) {
      if (model !== undefined || effort !== undefined) pins.push(`${name} is unpinned but its frontmatter sets ${model !== undefined ? `model "${model}"` : ''}${effort !== undefined ? ` effort "${effort}"` : ''}`.trim());
    } else {
      if (model !== pin.model) pins.push(`${name}: model "${model ?? '(none)'}" != pinned "${pin.model}"`);
      if (effort !== pin.effort) pins.push(`${name}: effort "${effort ?? '(none)'}" != pinned "${pin.effort}"`);
    }
    const exp = expectedFor(name, text, cfg);
    if (exp.retry !== null) {
      const vf = path.join(dir, `${retryName(name)}.md`);
      if (!fs.existsSync(vf)) variants.push(`${retryName(name)}.md missing`);
      else if (fs.readFileSync(vf, 'utf8').replace(/\r\n/g, '\n') !== exp.retry) variants.push(`${retryName(name)}.md is out of sync with ${name}.md`);
    }
  }
  const known = new Set([...names, ...retryBases(cfg).map(retryName)]);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const n = f.slice(0, -3);
      if (known.has(n)) continue;
      (n.endsWith(RETRY_SUFFIX) ? variants : pins).push(`${f} is not in the pinning table`);
    }
  }
  return { pins, variants, pinned: names.length, variantCount: retryBases(cfg).length };
}

/**
 * Write the normalized base definitions and the generated retry variants.
 * @returns {string[]} files written (changed content only)
 */
export function writeAgentDefinitions(dir = agentsDir(), cfg = loadConfig()) {
  const t = modelTable(cfg);
  const written = [];
  const put = (file, content) => {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (cur !== content) { fs.writeFileSync(file, content); written.push(file); }
  };
  for (const name of [...new Set([...Object.keys(t.pins), ...t.unpinned])]) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) throw new Error(`${file} missing; base definitions are written by hand`);
    const exp = expectedFor(name, fs.readFileSync(file, 'utf8'), cfg);
    if (exp.error) throw new Error(exp.error);
    put(file, /** @type {string} */ (exp.base));
    if (exp.retry !== null) put(path.join(dir, `${retryName(name)}.md`), exp.retry);
  }
  return written;
}
