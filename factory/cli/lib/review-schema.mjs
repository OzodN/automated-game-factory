// @ts-check
/**
 * The single owner of the review JSON schema (FX-01, defects FD-02/FD-03).
 *
 * Every independent review the factory ingests — game task reviews (`factory task review`) and factory
 * maintenance reviews (`factory maint merge`) — is validated here, strictly: unknown keys are refused at any
 * level with their exact path and a "did you mean" hint for the aliases reviewers actually used in the pilot
 * (`text` -> `issue`, `fix` -> `required_fix`, `acceptance` -> `criteria`, `APPROVE` -> `ACCEPT`).
 * All problems are reported at once. Reviewers self-check drafts with `factory review check <file>`;
 * `factory review schema` prints the schema with a filled example.
 *
 * Pure module: no file system, no state. Callers build the context (task id, attempt, reviewer,
 * acceptance ids) from the factory state and pass it in.
 */

export const VERDICTS = ['ACCEPT', 'REJECT'];
export const SEVERITIES = ['critical', 'major', 'minor', 'info'];
/** Severities that forbid an ACCEPT (task reviews are overridden to REJECT; maintenance merges are refused). */
export const BLOCKING_SEVERITIES = ['critical', 'major'];

const TOP_KEYS = ['taskId', 'attempt', 'reviewer', 'verdict', 'summary', 'criteria', 'findings', 'notes'];
/** Maintenance reviews additionally carry the reviewed commit and may list the tests the reviewer ran. */
const MAINT_KEYS = ['head', 'testsRun'];
const CRITERION_KEYS = ['id', 'met', 'evidence'];
const FINDING_KEYS = ['severity', 'file', 'line', 'issue', 'required_fix'];
const TEST_RUN_KEYS = ['name', 'command', 'result', 'detail'];

/** Key aliases seen in practice -> canonical key (the hint is shown only when the target is valid at that level). */
const KEY_ALIASES = {
  text: 'issue', description: 'issue', problem: 'issue', message: 'issue', title: 'issue',
  fix: 'required_fix', requiredFix: 'required_fix', required: 'required_fix', recommendation: 'required_fix', suggestion: 'required_fix', remedy: 'required_fix',
  acceptance: 'criteria', acceptanceCriteria: 'criteria', criterion: 'criteria', ac: 'criteria',
  issues: 'findings', defects: 'findings', comments: 'findings',
  status: 'met', passed: 'met', ok: 'met', result: 'met',
  proof: 'evidence', reason: 'evidence', detail: 'evidence', details: 'evidence',
  path: 'file', location: 'line', lineNumber: 'line',
  level: 'severity', priority: 'severity',
  task: 'taskId', task_id: 'taskId', id: 'taskId',
  agent: 'reviewer', reviewedBy: 'reviewer', decision: 'verdict', result_verdict: 'verdict', overview: 'summary', note: 'notes', comment: 'notes',
  sha: 'head', commit: 'head', tests: 'testsRun',
};
const VERDICT_ALIASES = { APPROVE: 'ACCEPT', APPROVED: 'ACCEPT', ACCEPTED: 'ACCEPT', PASS: 'ACCEPT', PASSED: 'ACCEPT', OK: 'ACCEPT', LGTM: 'ACCEPT', REJECTED: 'REJECT', FAIL: 'REJECT', FAILED: 'REJECT', CHANGES_REQUESTED: 'REJECT', REQUEST_CHANGES: 'REJECT' };
const SEVERITY_ALIASES = { blocker: 'critical', high: 'major', medium: 'minor', moderate: 'minor', low: 'minor', nit: 'minor', note: 'info', informational: 'info', suggestion: 'info' };

/**
 * @typedef {object} ReviewContext
 * @property {string} [taskId]      expected task / maintenance id
 * @property {number} [attempt]     expected (current) attempt
 * @property {string} [reviewer]    expected reviewer agent type
 * @property {string[]|null} [criteriaIds] acceptance ids that must each be assessed exactly once (null = unknown)
 * @property {boolean} [maintenance] factory maintenance review: `head` required, `testsRun` allowed,
 *   legacy `id` accepted for `taskId`, `criteria` optional when there are no acceptance ids
 */

const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'missing' : JSON.stringify(v));

function unknownKeys(obj, allowed, at, problems) {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    const alias = own(KEY_ALIASES, k) ?? own(KEY_ALIASES, k.toLowerCase());
    const hint = alias && allowed.includes(alias) ? `; did you mean ${alias}?` : `; allowed: ${allowed.join(', ')}`;
    problems.push(`${at ? `${at}.` : ''}${k}: unknown key${hint}`);
  }
}

function enumProblem(at, v, allowed, aliases) {
  const s = typeof v === 'string' ? v : '';
  const guess = own(aliases, s) ?? own(aliases, s.toUpperCase()) ?? own(aliases, s.toLowerCase()) ??
    allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  return `${at}: ${show(v)} is not allowed (${allowed.join('|')})${guess ? `; did you mean ${guess}?` : ''}`;
}

/**
 * Validate a parsed review against the schema and (optionally) the task context.
 * @param {any} r parsed JSON
 * @param {ReviewContext} [ctx]
 * @returns {string[]} every problem, each prefixed with its exact path; [] = valid
 */
export function validateReview(r, ctx = {}) {
  /** @type {string[]} */
  const p = [];
  if (!isObj(r)) return ['(root): the review must be a JSON object'];
  const maint = !!ctx.maintenance;
  const allowedTop = maint ? [...TOP_KEYS, ...MAINT_KEYS] : TOP_KEYS;
  const legacyId = maint && 'id' in r;
  unknownKeys(legacyId ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id')) : r, allowedTop, '', p);

  // taskId (maintenance: the legacy `id` of the FX-00 packets is accepted, but not both).
  if (legacyId && 'taskId' in r) p.push('id: use only taskId (id is its legacy alias for maintenance reviews)');
  const tid = legacyId && !('taskId' in r) ? r.id : r.taskId;
  const tidKey = legacyId && !('taskId' in r) ? 'id' : 'taskId';
  if (!nonEmpty(tid)) p.push(`${tidKey}: required non-empty string (the task id)`);
  else if (ctx.taskId !== undefined && tid !== ctx.taskId) p.push(`${tidKey}: ${show(tid)} must equal the task id ${show(ctx.taskId)}`);

  if (!Number.isInteger(r.attempt) || r.attempt < 1) p.push(`attempt: required positive integer, got ${show(r.attempt)}`);
  else if (ctx.attempt !== undefined && r.attempt !== ctx.attempt) p.push(`attempt: ${r.attempt} must equal the current attempt ${ctx.attempt}`);

  if (!nonEmpty(r.reviewer)) p.push('reviewer: required non-empty string (your agent type)');
  else if (ctx.reviewer !== undefined && r.reviewer !== ctx.reviewer) p.push(`reviewer: ${show(r.reviewer)} must equal the assigned reviewer ${show(ctx.reviewer)}`);

  if (!VERDICTS.includes(r.verdict)) p.push(enumProblem('verdict', r.verdict, VERDICTS, VERDICT_ALIASES));
  if (!nonEmpty(r.summary)) p.push('summary: required non-empty string');
  if ('notes' in r && typeof r.notes !== 'string') p.push('notes: must be a string when present');

  if (maint) {
    if (typeof r.head !== 'string' || !/^[0-9a-f]{7,40}$/i.test(r.head)) p.push(`head: required sha of the reviewed commit (7-40 hex chars), got ${show(r.head)}`);
    if ('testsRun' in r) {
      if (!Array.isArray(r.testsRun)) p.push('testsRun: must be an array when present');
      else r.testsRun.forEach((t, i) => {
        const at = `testsRun[${i}]`;
        if (!isObj(t)) { p.push(`${at}: must be an object`); return; }
        unknownKeys(t, TEST_RUN_KEYS, at, p);
        if (!nonEmpty(t.command) && !nonEmpty(t.name)) p.push(`${at}.command: required non-empty string`);
        if (!nonEmpty(t.result)) p.push(`${at}.result: required non-empty string (pass|fail)`);
      });
    }
  }

  // criteria[]
  const expected = Array.isArray(ctx.criteriaIds) ? ctx.criteriaIds : null;
  const criteriaOptional = maint && (!expected || expected.length === 0);
  if (!('criteria' in r)) {
    if (!criteriaOptional) p.push(`criteria: required array${expected ? ` with one entry per acceptance id (${expected.join(', ')})` : ''}`);
  } else if (!Array.isArray(r.criteria)) p.push('criteria: must be an array');
  else {
    const seen = new Map();
    r.criteria.forEach((c, i) => {
      const at = `criteria[${i}]`;
      if (!isObj(c)) { p.push(`${at}: must be an object { id, met, evidence }`); return; }
      unknownKeys(c, CRITERION_KEYS, at, p);
      if (!nonEmpty(c.id)) p.push(`${at}.id: required non-empty string (an acceptance id)`);
      else {
        if (seen.has(c.id)) p.push(`${at}.id: duplicate ${c.id} (already assessed in criteria[${seen.get(c.id)}])`);
        else seen.set(c.id, i);
        if (expected && !expected.includes(c.id)) p.push(`${at}.id: unknown acceptance id ${show(c.id)} (expected ${expected.join(', ') || 'none'})`);
      }
      if (typeof c.met !== 'boolean') p.push(`${at}.met: required boolean, got ${show(c.met)}`);
      if (!nonEmpty(c.evidence)) p.push(`${at}.evidence: required non-empty string`);
    });
    if (expected) for (const id of expected) if (!seen.has(id)) p.push(`criteria: missing criterion ${id} (every acceptance id must be assessed exactly once)`);
  }

  // findings[]
  if (!('findings' in r)) p.push('findings: required array (use [] when there are none)');
  else if (!Array.isArray(r.findings)) p.push('findings: must be an array');
  else r.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!isObj(f)) { p.push(`${at}: must be an object { severity, file?, line?, issue, required_fix }`); return; }
    unknownKeys(f, FINDING_KEYS, at, p);
    if (!SEVERITIES.includes(f.severity)) p.push(enumProblem(`${at}.severity`, f.severity, SEVERITIES, SEVERITY_ALIASES));
    if ('file' in f && !nonEmpty(f.file)) p.push(`${at}.file: must be a non-empty string when present`);
    if ('line' in f && (!Number.isInteger(f.line) || f.line < 1)) p.push(`${at}.line: must be a positive integer when present, got ${show(f.line)}`);
    if (!nonEmpty(f.issue)) p.push(`${at}.issue: required non-empty string`);
    if (!nonEmpty(f.required_fix)) p.push(`${at}.required_fix: required non-empty string`);
  });
  return p;
}

/**
 * Semantic consequences of a structurally valid review (not schema errors).
 * @param {any} r @returns {{unmet: string[], serious: any[]}}
 */
export function reviewConsequences(r) {
  const unmet = Array.isArray(r?.criteria) ? r.criteria.filter((c) => c?.met !== true).map((c) => String(c?.id)) : [];
  const serious = Array.isArray(r?.findings) ? r.findings.filter((f) => BLOCKING_SEVERITIES.includes(f?.severity)) : [];
  return { unmet, serious };
}

/**
 * A filled, valid example for the context (used by `review schema`, packets and agent docs).
 * @param {ReviewContext} [ctx]
 */
export function reviewExample(ctx = {}) {
  const ids = Array.isArray(ctx.criteriaIds) ? ctx.criteriaIds : (ctx.maintenance ? [] : ['AC1', 'AC2']);
  const ex = {
    taskId: ctx.taskId ?? (ctx.maintenance ? 'FX-01' : 'P2-CORE-01'),
    attempt: ctx.attempt ?? 1,
    reviewer: ctx.reviewer ?? 'code-reviewer',
    ...(ctx.maintenance ? { head: '0123456789abcdef0123456789abcdef01234567' } : {}),
    verdict: 'REJECT',
    summary: 'One paragraph: what was reviewed (diff, tests, evidence) and why this verdict.',
    // The first criterion is shown unmet (matching the REJECT and the finding) unless it is the only one.
    criteria: ids.map((id, i) => (i === 0 && ids.length > 1
      ? { id, met: false, evidence: 'src/game/x.ts:12 returns the wrong value; no test covers it' }
      : { id, met: true, evidence: 'tests/unit/x.test.ts "GD-004 ..." asserts the value; verify.json step:unit exit 0' })),
    findings: [{ severity: 'major', file: 'src/game/x.ts', line: 12, issue: 'What is wrong and why it matters.', required_fix: 'The concrete change that resolves it.' }],
    ...(ctx.maintenance ? { testsRun: [{ command: 'node --test factory/cli/test/*.test.mjs', result: 'pass' }] } : {}),
    notes: '',
  };
  return ex;
}

/**
 * Markdown description of the schema with a filled example (for `review schema` and the packets).
 * @param {ReviewContext} [ctx]
 */
export function renderReviewSchema(ctx = {}) {
  const maint = !!ctx.maintenance;
  const ids = Array.isArray(ctx.criteriaIds) ? ctx.criteriaIds : null;
  return [
    `Review JSON schema (${maint ? 'factory maintenance review' : 'game task review'}; strictly validated, unknown keys are refused at every level)`,
    '',
    `- taskId: string — ${ctx.taskId ? `exactly "${ctx.taskId}"` : 'the task id'}${maint ? ' (legacy alias: id)' : ''}`,
    `- attempt: integer — ${ctx.attempt ? `exactly ${ctx.attempt}` : 'the current attempt'}`,
    `- reviewer: string — ${ctx.reviewer ? `exactly "${ctx.reviewer}"` : 'your agent type'}`,
    ...(maint ? ['- head: string — full sha of the commit you reviewed (`git rev-parse HEAD` in the worktree)'] : []),
    `- verdict: ${VERDICTS.join(' | ')}`,
    '- summary: non-empty string',
    `- criteria: array of { id: string, met: boolean, evidence: non-empty string } — ${ids ? (ids.length ? `every acceptance id exactly once: ${ids.join(', ')}; no other ids` : 'no acceptance ids defined: [] (may be omitted)') : 'every acceptance id of the task exactly once, no other ids'}`,
    `- findings: array (may be []) of { severity: ${SEVERITIES.join(' | ')}, file?: string, line?: positive integer, issue: non-empty string, required_fix: non-empty string }`,
    ...(maint ? ['- testsRun (optional): array of { command: string, result: string, detail?: string }'] : []),
    '- notes (optional): string',
    '',
    `Rules: ACCEPT only when every criterion is met with concrete evidence and there are no ${BLOCKING_SEVERITIES.join('/')} findings` +
      `${maint ? ' (maint merge refuses any other ACCEPT)' : ' (the CLI records any other ACCEPT as REJECT)'}. ` +
      'Common mistakes the validator refuses: text (use issue), fix (use required_fix), acceptance (use criteria), APPROVE (use ACCEPT).',
    '',
    'Filled example:',
    '```json',
    JSON.stringify(reviewExample(ctx), null, 2),
    '```',
  ].join('\n');
}

/**
 * One finding as a single line for retry packets and blocker reports. Never prints `undefined`: findings
 * recorded before strict validation (pilot) may use the aliases, so they are read as a fallback.
 * @param {any} f
 */
export function formatFinding(f) {
  if (!isObj(f)) return `[unknown] ${String(f ?? '(empty finding)')}`;
  const pick = (...vals) => vals.find((v) => nonEmpty(v)) ?? null;
  const severity = pick(f.severity) ?? 'unknown';
  const loc = nonEmpty(f.file) ? `${f.file}${Number.isInteger(f.line) ? `:${f.line}` : ''} ` : '';
  const issue = pick(f.issue, f.text, f.description) ?? '(no issue text recorded)';
  const fix = pick(f.required_fix, f.fix, f.requiredFix);
  return `[${severity}] ${loc}${issue}${fix ? ` => required: ${fix}` : ''}`;
}

/**
 * Acceptance ids a factory maintenance brief defines: list items under a heading named "Acceptance"
 * (e.g. `## Acceptance criteria`), each starting with an id in bold, in backticks or followed by a colon:
 * `- **AC1** ...`, ``- `FX01-AC2` ...``, `- AC3: ...`. No such section -> [].
 * @param {string} text
 * @returns {string[]}
 */
export function parseBriefAcceptanceIds(text) {
  const ids = [];
  let level = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (/^acceptance\b/i.test(h[2].trim())) level = h[1].length;
      else if (level && h[1].length <= level) level = 0;
      continue;
    }
    if (!level) continue;
    const m = line.match(/^\s*[-*]\s+(?:\*\*([A-Za-z][\w.-]*)\*\*|`([A-Za-z][\w.-]*)`|([A-Z][A-Z0-9_.-]*[0-9])\s*:)/);
    const id = m && (m[1] || m[2] || m[3]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
