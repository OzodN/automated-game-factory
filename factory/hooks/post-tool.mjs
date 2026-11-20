#!/usr/bin/env node
// @ts-check
/** PostToolUse (Playgama MCP write tools): record the REAL tool result as a publication event. */
import { readInput } from './_io.mjs';
import { PLAYGAMA_WRITE_TOOLS, opForTool } from '../cli/lib/approvals.mjs';
import { getFocus, gameExists, commit } from '../cli/lib/state.mjs';

const input = await readInput();
try {
  const name = String(input.tool_name || '').split('__').pop();
  if (PLAYGAMA_WRITE_TOOLS.has(name)) {
    const g = getFocus();
    if (g && gameExists(g)) {
      const resp = JSON.stringify(input.tool_response ?? '').slice(0, 3000);
      commit(g, [{
        type: 'publication.op',
        data: { tool: name, op: opForTool(name), input: JSON.stringify(input.tool_input || {}).slice(0, 1500), response: resp, agentType: input.agent_type || 'main' },
      }], { actor: 'hook' });
    }
  }
} catch (e) {
  process.stderr.write(`factory post-tool hook error: ${e?.stack || e}\n`);
}
