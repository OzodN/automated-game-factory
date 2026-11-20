#!/usr/bin/env node
// @ts-check
/**
 * UserPromptSubmit: the ONLY place human approvals/decisions are minted. It sees the literal text the
 * human typed; agents cannot trigger it. Records an HMAC-signed token bound to the current artifact.
 */
import { readInput, emit } from './_io.mjs';
import { parseCommand, mintRecord, computeTarget, PUBLISH_OPS } from '../cli/lib/approvals.mjs';
import { listGames, getFocus, loadState, gameExists } from '../cli/lib/state.mjs';
import { paths } from '../cli/lib/core.mjs';

const input = await readInput();
try {
  const games = listGames();
  const parsed = parseCommand(input.prompt || '', games);
  if (parsed) {
    const game = parsed.args.game || getFocus();
    let target = null;
    let note = '';
    if (parsed.kind === 'gate') {
      if (!game || !gameExists(game)) {
        note = 'No focused game: the approval was NOT recorded. Tell the user to include the game id.';
      } else {
        const s = loadState(game);
        if (parsed.command === 'authorize-publish' && !parsed.args.op) note = `Missing operation. Valid: ${Object.keys(PUBLISH_OPS).join(', ')}. NOT recorded.`;
        else if (parsed.command === 'abandon-game' && !parsed.args.text) note = `Missing reason: the approval was NOT recorded. Tell the user to type: /abandon-game ${game} <reason>`;
        else target = computeTarget(parsed.command, s, parsed.args, `${paths().games}/${game}`);
      }
    }
    if (!note) {
      const rec = mintRecord({ kind: parsed.kind, command: parsed.command, game: game || null, target, args: parsed.args, prompt: input.prompt, sessionId: input.session_id });
      const opInfo = parsed.args.op ? ` op=${parsed.args.op} (${PUBLISH_OPS[parsed.args.op].describe})` : '';
      note = `Human ${parsed.kind} recorded and signed: /${parsed.command} game=${game}${opInfo} target=${String(target).slice(0, 40)} id=${rec.id.slice(0, 8)}. ` +
        (parsed.kind === 'gate'
          ? `It is bound to the current artifact state and is single-use. Run the matching factory command now (see the /${parsed.command} skill).`
          : 'Apply the decision via the matching factory command.');
    }
    emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[factory-hook] ${note}` } });
  }
} catch (e) {
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[factory-hook] ERROR recording decision: ${e?.message || e}. The decision was NOT recorded.` } });
}
