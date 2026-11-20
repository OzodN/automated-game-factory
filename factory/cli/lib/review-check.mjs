// @ts-check
/**
 * `factory review check` / `factory review schema`: resolve the review context (game task or factory
 * maintenance item) and validate a draft with the unified schema (review-schema.mjs) without recording anything.
 * Read-only: reviewers run it as a self-check before finishing.
 */
import path from 'node:path';
import { paths, samePathPrefix, norm, FactoryError } from './core.mjs';
import { loadState, gameExists, resolveGame } from './state.mjs';
import { reviewContext, readReviewJson } from './tasks.mjs';
import { loadMaint, maintReviewContext, MAINT_GAME, FX_ID_RE } from './maint.mjs';
import { validateReview, reviewConsequences } from './review-schema.mjs';

/**
 * @param {string} task @param {string} [game]
 * @returns {{ctx: import('./review-schema.mjs').ReviewContext, scope: string}}
 */
export function reviewContextFor(task, game) {
  if (game === MAINT_GAME || (!game && FX_ID_RE.test(task) && loadMaint()[task])) {
    return { ctx: maintReviewContext(task), scope: `factory maintenance ${task}` };
  }
  const g = resolveGame(game);
  const ctx = reviewContext(g, task);
  return { ctx, scope: `${g} ${task} attempt ${ctx.attempt}` };
}

/** Infer { game, task } from `<inbox>/<game>/<task>/review-a<n>.json`, or null. */
function inferFromPath(file) {
  const inbox = paths().inbox;
  if (!samePathPrefix(file, inbox)) return null;
  const parts = norm(file).slice(inbox.length + 1).split('/');
  if (parts.length !== 3 || !/^review-a\d+\.json$/i.test(parts[2])) return null;
  const [game, task] = parts;
  if (game === MAINT_GAME) return loadMaint()[task] ? { game, task } : null;
  if (!gameExists(game)) return null;
  const t = loadState(game).tasks[task];
  return t && t.attempts.length ? { game, task } : null;
}

/**
 * @param {string} file absolute path
 * @param {string} [task] @param {string} [game]
 */
export function checkReviewFile(file, task, game) {
  /** @type {import('./review-schema.mjs').ReviewContext} */
  let ctx = {};
  let scope = 'structure only: no task context (pass --task <id> --game <g> to check ids, attempt and reviewer)';
  if (task) ({ ctx, scope } = reviewContextFor(task, game));
  else if (game) throw new FactoryError('--game needs --task <id>.');
  else {
    const inf = inferFromPath(file);
    if (inf) ({ ctx, scope } = reviewContextFor(inf.task, inf.game));
  }
  const parsed = readReviewJson(file);
  const problems = parsed.ok ? validateReview(parsed.value, ctx) : [parsed.error];
  const notes = [];
  const fileAttempt = Number(path.basename(file).match(/^review-a(\d+)\.json$/i)?.[1] ?? NaN);
  if (Number.isInteger(ctx.attempt) && Number.isInteger(fileAttempt) && fileAttempt !== ctx.attempt) {
    notes.push(fileAttempt < /** @type {number} */ (ctx.attempt)
      ? `the file name says attempt ${fileAttempt}, but the task is at attempt ${ctx.attempt}: this is an old review; write review-a${ctx.attempt}.json for the current attempt`
      : `the file name says attempt ${fileAttempt}, but the task is at attempt ${ctx.attempt}: write review-a${ctx.attempt}.json`);
  }
  if (parsed.ok && !problems.length && parsed.value.verdict === 'ACCEPT') {
    const { unmet, serious } = reviewConsequences(parsed.value);
    if (unmet.length || serious.length) {
      notes.push(`verdict ACCEPT with unmet criteria [${unmet.join(', ')}] and ${serious.length} critical/major finding(s): ` +
        (ctx.maintenance ? 'maint merge refuses this review' : 'the CLI will record it as REJECT'));
    }
  }
  return { ok: problems.length === 0, file: path.resolve(file), scope, problems, notes };
}
