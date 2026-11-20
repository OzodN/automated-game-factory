#!/usr/bin/env node
// @ts-check
/** SessionStart (startup/resume/compact/clear): rebuild orchestrator context from durable state. */
import { readInput, emit } from './_io.mjs';
import { factoryOverview, recover } from '../cli/lib/reports.mjs';
import { loadMaint, maintFindings } from '../cli/lib/maint.mjs';
import { humanLanguageLine, AUTO_LINE } from '../cli/lib/language.mjs';

const input = await readInput();
let ctx = '';
try {
  const overview = factoryOverview({ brief: false });
  const findings = [...recover({ apply: false }), ...safeMaintFindings()];
  ctx = [
    `[factory] Session ${input.source || 'start'}: authoritative state reconstructed from .factory/ event logs (never from memory).`,
    safeLanguageLine(),
    overview,
    maintenanceSection(),
    findings.length
      ? `Recovery findings (act on these before new work):\n${findings.map((f) => `- [${f.kind}] ${f.game || ''} ${f.task || ''} ${f.detail || ''} -> ${f.fix}`).join('\n')}`
      : 'Recovery: consistent.',
  ].filter(Boolean).join('\n\n');
} catch (e) {
  ctx = [`[factory] Could not load factory state: ${e?.message || e}. Run: node factory/cli/factory.mjs status`, safeLanguageLine()].join('\n\n');
}
emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } });

/** Isolated so an unreadable config never hides the state overview; falls back to the default. */
function safeLanguageLine() {
  try { return humanLanguageLine(); } catch { return AUTO_LINE; }
}

function safeMaintFindings() {
  try { return maintFindings(); } catch (e) { return [{ kind: 'maint-check', detail: String(e?.message || e), fix: 'factory maint list' }]; }
}

/** Open factory maintenance items; isolated so a bad maintenance log never hides the rest of the context. */
function maintenanceSection() {
  try {
    const open = Object.values(loadMaint()).filter((m) => m.status !== 'MERGED');
    return open.length
      ? `Open factory maintenance (worktrees of the factory repo):\n${open.map((m) => `- ${m.id} ${m.status} ${m.agent} -> ${m.reviewer}: ${m.title} (next: node factory/cli/factory.mjs maint show ${m.id})`).join('\n')}`
      : '';
  } catch (e) {
    return `[factory] Maintenance log unreadable: ${e?.message || e}. Run: node factory/cli/factory.mjs maint list`;
  }
}
