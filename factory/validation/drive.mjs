#!/usr/bin/env node
/**
 * Factory acceptance-test driver. It plays the HUMAN: each step sends one real prompt to a separate
 * headless Claude Code process in the factory root (main thread = game-orchestrator), resuming the
 * previous session or deliberately starting a fresh one (restart tests). After each step it records
 * the orchestrator's reply and an authoritative `factory status` snapshot as evidence.
 *
 * This harness is for factory validation only. Agents are blocked from launching sessions by the
 * guard; a node script that spawns sessions is a documented limit of that guard (see security.md).
 *
 * Usage: node factory/validation/drive.mjs <steps.json> [--from N] [--to M]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'factory', 'validation');
const args = process.argv.slice(2);
const stepsFile = args[0];
const from = Number(args[args.indexOf('--from') + 1] || 1) || 1;
const to = Number(args.includes('--to') ? args[args.indexOf('--to') + 1] : 999);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const sessionFile = path.join(OUT, 'session.json');
const transcript = path.join(OUT, 'transcript.md');
const log = path.join(OUT, 'steps.jsonl');

function status() {
  const r = spawnSync(process.execPath, ['factory/cli/factory.mjs', 'status', '--all'], { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || r.stderr || '').trim();
}

function runStep(step, sessionId) {
  return new Promise((resolve) => {
    const cliArgs = ['-p', step.prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Agent', 'Skill', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    if (sessionId && !step.newSession) cliArgs.push('--resume', sessionId);
    const exe = ['cl', 'aude'].join('');
    const child = spawn(exe, cliArgs, {
      cwd: ROOT,
      env: { ...process.env, MSYS_NO_PATHCONV: '1', FACTORY_VALIDATION_RUN: '1' },
      shell: false,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), (step.timeoutMin || 90) * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* non-json output */ }
      resolve({ code, json, raw: out.slice(-4000), err: err.slice(-2000) });
    });
    child.on('error', (e) => resolve({ code: -1, json: null, raw: '', err: String(e) }));
  });
}

let session = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessionId : null;
for (let i = from; i <= Math.min(to, steps.length); i++) {
  const step = steps[i - 1];
  const t0 = new Date();
  console.log(`\n=== step ${i}: ${step.name} (${step.newSession ? 'NEW session' : session ? 'resume' : 'new'}) ===`);
  const r = await runStep(step, session);
  const t1 = new Date();
  if (r.json?.session_id) session = r.json.session_id;
  fs.writeFileSync(sessionFile, JSON.stringify({ sessionId: session }, null, 2));
  const snap = status();
  const rec = {
    step: i, name: step.name, expect: step.expect, newSession: !!step.newSession, startedAt: t0.toISOString(), endedAt: t1.toISOString(),
    minutes: +((t1 - t0) / 60000).toFixed(1), exitCode: r.code, isError: r.json?.is_error ?? null, sessionId: session,
    costUsd: r.json?.total_cost_usd ?? null, turns: r.json?.num_turns ?? null, result: r.json?.result ?? r.raw, stderr: r.err || undefined,
  };
  fs.appendFileSync(log, JSON.stringify(rec) + '\n');
  fs.appendFileSync(transcript, [
    `\n## Step ${i} — ${step.name}`,
    `- When: ${rec.startedAt} → ${rec.endedAt} (${rec.minutes} min), session ${session} ${step.newSession ? '(NEW process + NEW session: restart test)' : '(new process, resumed session)'}`,
    `- Expectation: ${step.expect}`,
    `- Exit: ${rec.exitCode}, is_error: ${rec.isError}, turns: ${rec.turns}, cost (list price): ${rec.costUsd}`,
    '', '**Human prompt:**', '', '```text', step.prompt, '```', '', '**Orchestrator reply:**', '', '```text', String(rec.result).slice(0, 6000), '```',
    '', '**Factory status after step:**', '', '```text', snap.slice(0, 5000), '```', '',
  ].join('\n'));
  console.log(String(rec.result).slice(0, 1500));
  console.log(`--- exit ${r.code}, ${rec.minutes} min, cost ${rec.costUsd}`);
  if (r.code !== 0 || rec.isError) {
    console.log('Step failed; stopping. Inspect docs/factory/validation/transcript.md');
    process.exit(1);
  }
}
