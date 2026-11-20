#!/usr/bin/env node
// @ts-check
/**
 * Applies the pinning table (factory/config.json "models") to .claude/agents/*.md:
 * sets model/effort in every base definition (removes them for unpinned agents such as the orchestrator)
 * and regenerates the `<agent>-retry` variants (identical body and tools, retry pin).
 *
 *   node factory/cli/gen-agent-models.mjs           write the definitions
 *   node factory/cli/gen-agent-models.mjs --check   exit 1 if any definition is out of sync (no writes)
 *
 * Base bodies are edited by hand; variants are never edited by hand.
 */
import { checkAgentDefinitions, writeAgentDefinitions, agentsDir } from './lib/agents.mjs';

const check = process.argv.includes('--check');
if (check) {
  const r = checkAgentDefinitions();
  const problems = [...r.pins, ...r.variants];
  if (problems.length) {
    console.error(`agent definitions out of sync (${problems.length}):\n - ${problems.join('\n - ')}\nRun: node factory/cli/gen-agent-models.mjs`);
    process.exit(1);
  }
  console.log(`agent definitions in sync: ${r.pinned} base definitions, ${r.variantCount} retry variants (${agentsDir()})`);
} else {
  const written = writeAgentDefinitions();
  console.log(written.length ? `wrote ${written.length} file(s):\n${written.map((f) => `  ${f}`).join('\n')}` : 'agent definitions already in sync');
  const r = checkAgentDefinitions();
  const problems = [...r.pins, ...r.variants];
  if (problems.length) {
    console.error(`remaining problems (fix by hand):\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
}
