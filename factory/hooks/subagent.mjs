#!/usr/bin/env node
// @ts-check
/**
 * SubagentStart / SubagentStop: track active agents (concurrency + recovery), record runs with token
 * usage for metrics, and refuse to let an implementer stop without writing its task report (once).
 * Implementer = base role, so `<agent>-retry` variants are held to the same rule. An agent whose claim was
 * superseded by a newer attempt or released by the orchestrator is not asked for a report (FX-02).
 */
import fs from 'node:fs';
import { readInput, emit } from './_io.mjs';
import { paths, readJson, writeJsonAtomic, appendJsonl, nowIso, acquireLock } from '../cli/lib/core.mjs';
import { FACTORY_AGENTS, baseRole } from '../cli/lib/agents.mjs';
import { claimState, claimEnded } from '../cli/lib/claims.mjs';

const input = await readInput();
const p = paths();
const release = acquireLock(`${p.state}/.agents.lock`, { staleMs: 10000, timeoutMs: 8000 });
try {
  const m = readJson(p.agentMap, { agents: {} });
  m.agents ||= {};
  const id = input.agent_id;
  if (input.hook_event_name === 'SubagentStart') {
    m.agents[id] = { ...(m.agents[id] || {}), agentType: input.agent_type, startedAt: nowIso(), active: true, sessionId: input.session_id };
    writeJsonAtomic(p.agentMap, m);
  } else if (input.hook_event_name === 'SubagentStop') {
    const a = m.agents[id] || { agentType: input.agent_type };
    const reportFile = a.task ? `${p.inbox}/${a.game}/${a.task}/report-a${a.attempt}.json` : null;
    if (FACTORY_AGENTS.implementers.includes(baseRole(a.agentType)) && reportFile && !fs.existsSync(reportFile) && !input.stop_hook_active && !claimEnded(claimState(a))) {
      emit({
        decision: 'block',
        reason: `[factory] You claimed ${a.task} but have not written ${reportFile}. Commit your work in the worktree and write the report with the Write tool before finishing (if you are blocked, write the report and explain in unresolvedDefects).`,
      });
    } else {
      a.active = false;
      a.stoppedAt = nowIso();
      m.agents[id] = a;
      writeJsonAtomic(p.agentMap, m);
      appendJsonl(p.agentRuns, {
        agentId: id, agentType: a.agentType, game: a.game || null, task: a.task || null, attempt: a.attempt || null,
        startedAt: a.startedAt, stoppedAt: a.stoppedAt,
        durationMs: a.startedAt ? Date.parse(a.stoppedAt) - Date.parse(a.startedAt) : null,
        transcript: input.agent_transcript_path || null, tokens: usage(input.agent_transcript_path),
      });
    }
  }
} catch (e) {
  process.stderr.write(`factory subagent hook error: ${e?.stack || e}\n`);
} finally {
  release();
}

/** Sum API usage from a subagent transcript (deduplicated by message id). */
function usage(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    let inTok = 0; let outTok = 0; let cacheRead = 0; let cacheWrite = 0;
    const seen = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      const j = JSON.parse(line);
      const u = j.message?.usage;
      const mid = j.message?.id;
      if (!u || (mid && seen.has(mid))) continue;
      if (mid) seen.add(mid);
      inTok += u.input_tokens || 0; outTok += u.output_tokens || 0;
      cacheRead += u.cache_read_input_tokens || 0; cacheWrite += u.cache_creation_input_tokens || 0;
    }
    return { input: inTok, output: outTok, cacheRead, cacheWrite, total: inTok + outTok + cacheWrite };
  } catch { return null; }
}
