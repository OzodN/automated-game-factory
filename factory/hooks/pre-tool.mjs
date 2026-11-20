#!/usr/bin/env node
// @ts-check
/** PreToolUse: factory guard (protected state, write scopes, approvals, Playgama gating, concurrency). */
import { readInput, emit } from './_io.mjs';
import { decide, applyEffects, logDecision } from '../cli/lib/guard.mjs';
import { scratchPathHint } from '../cli/lib/tmp-hint.mjs';

const input = await readInput();
let result;
try {
  result = decide(input);
  if (result.decision !== 'deny') applyEffects(result.effects);
} catch (e) {
  // Fail closed for anything that could publish or corrupt state; fail open otherwise.
  const risky = /^mcp__.*playgama/i.test(input.tool_name || '') || /\.factory|\.game-factory/.test(JSON.stringify(input.tool_input || {}));
  result = risky ? { decision: 'deny', reason: `factory guard error (fail-closed): ${e?.message || e}` } : { decision: null };
  process.stderr.write(`factory guard error: ${e?.stack || e}\n`);
}
try { logDecision(input, result); } catch { /* logging must not block */ }
if (result.decision === 'deny') {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[factory] ${result.reason}` } });
} else if (input.tool_name === 'Bash') {
  // FX-16: advisory only (no permission decision): temp paths that native programs would put at the drive root.
  // The drive-root hazard (MSYS_NO_PATHCONV with Git Bash) exists on Windows only, so the MSYS wording is win32-only;
  // elsewhere a platform-neutral hint still keeps scratch files inside the factory (FX-19, FX-20).
  let hint = null;
  try { hint = scratchPathHint(input.tool_input?.command, process.platform); } catch { /* a hint must never block */ }
  if (hint) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[factory] ${hint}` } });
}
