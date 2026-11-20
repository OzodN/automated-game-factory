#!/usr/bin/env node
/**
 * Factory build validator (stricter than Playgama's own 300 MB limit so builds stay eligible for
 * partner platforms). Then runs Playgama's OFFICIAL precheck (playgama-publish skill) when installed.
 * Usage: node scripts/validate-build.mjs dist [--release]
 *   --release additionally requires audio files (rule 3.3.1), credits and a license ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const dist = path.resolve(process.argv[2] || 'dist');
const release = process.argv.includes('--release');
const LIMITS = { bytes: 25 * 1024 * 1024, files: 250, fileBytes: 10 * 1024 * 1024 };
const rows = [];
const add = (level, rule, msg) => rows.push({ level, rule, msg });

function walk(d, base = d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, base, out);
    else out.push({ rel: path.relative(base, f).replace(/\\/g, '/'), size: fs.statSync(f).size, full: f });
  }
  return out;
}

if (!fs.existsSync(dist)) {
  console.error(`FAIL build folder ${dist} does not exist (run the build first)`);
  process.exit(1);
}
const files = walk(dist);
const total = files.reduce((a, f) => a + f.size, 0);
const names = files.map((f) => f.rel);
if (!names.includes('index.html')) add('FAIL', '1.3.2', 'index.html missing at the build root');
if (!names.includes('playgama-bridge-config.json')) add('FAIL', '1.1.1', 'playgama-bridge-config.json missing next to index.html');
else {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dist, 'playgama-bridge-config.json'), 'utf8'));
    if (cfg.forciblySetPlatformId) add('FAIL', 'SDK', `forciblySetPlatformId must be empty in builds (got "${cfg.forciblySetPlatformId}")`);
  } catch (e) {
    add('FAIL', 'SDK', `playgama-bridge-config.json is not valid JSON: ${e.message}`);
  }
}
const unsafe = names.filter((n) => !/^[A-Za-z0-9._/-]+$/.test(n));
if (unsafe.length) add('FAIL', '1.3.2', `unsafe file names: ${unsafe.slice(0, 5).join(', ')}`);
if (total > LIMITS.bytes) add('FAIL', 'FACTORY', `build is ${(total / 1048576).toFixed(1)} MB (> 25 MB factory target)`);
if (files.length > LIMITS.files) add('FAIL', 'FACTORY', `${files.length} files (> ${LIMITS.files} factory target)`);
for (const f of files) if (f.size > LIMITS.fileBytes) add('FAIL', 'FACTORY', `${f.rel} exceeds 10 MB`);
if (names.some((n) => n.endsWith('.map'))) add('FAIL', 'FACTORY', 'source maps must not ship');

const html = fs.existsSync(path.join(dist, 'index.html')) ? fs.readFileSync(path.join(dist, 'index.html'), 'utf8') : '';
const extSrc = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g)].map((m) => m[1]).filter((u) => !/^https:\/\/bridge\.playgama\.com\//.test(u));
if (extSrc.length) add('FAIL', '1.2.5', `index.html loads external resources: ${extSrc.join(', ')}`);
if (/fonts\.googleapis|fonts\.gstatic/.test(html)) add('FAIL', '1.2.5', 'Google Fonts loaded from the web (self-host fonts)');
if (!/bridge\.playgama\.com\/v2\/|playgama-bridge\.js/.test(html)) add('FAIL', '1.1.1', 'Playgama Bridge v2 script tag not found in index.html');
const ANALYTICS = /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|mc\.yandex\.ru|cdn\.segment\.com|api\.amplitude\.com|static\.hotjar\.com|clarity\.ms/;
// The official Bridge runtime references partner platforms' own SDK hosts; it is exempt.
for (const f of files.filter((x) => /\.(js|html)$/.test(x.rel) && x.rel !== 'playgama-bridge.js')) {
  if (ANALYTICS.test(fs.readFileSync(f.full, 'utf8'))) add('FAIL', '1.2.4', `third-party analytics in ${f.rel}`);
}
const audio = names.filter((n) => /\.(ogg|mp3)$/i.test(n));
if (release) {
  if (!audio.length) add('FAIL', '3.3.1', 'no ogg/mp3 audio files: the game must have music and sound effects');
  const ledgerFile = path.resolve('assets/LICENSES.json');
  if (!fs.existsSync(ledgerFile) || !fs.existsSync(path.resolve('CREDITS.md'))) add('FAIL', 'AS-03', 'assets/LICENSES.json and CREDITS.md are required for release');
  else {
    const testOnly = (JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).assets || []).filter((a) => a.testOnly);
    if (testOnly.length) {
      add(process.env.FACTORY_VALIDATION_RUN === '1' ? 'WARN' : 'FAIL', 'AS-01',
        `${testOnly.length} TEST-ONLY asset(s) (not releasable): ${testOnly.slice(0, 4).map((a) => a.path).join(', ')}`);
    }
  }
  if (names.some((n) => /\.wav$/i.test(n))) add('FAIL', '3.3.2', 'ship compressed audio (ogg/mp3), not wav');
} else if (!audio.length) add('WARN', '3.3.1', 'no audio files yet (required before release)');

// Official Playgama precheck (playgama-publish skill), when the plugin is installed.
const precheck = findOfficialPrecheck();
if (precheck) {
  const r = spawnSync(process.execPath, [precheck, dist], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  add(r.status === 0 ? 'PASS' : 'FAIL', 'PLAYGAMA', `official precheck ${r.status === 0 ? 'passed' : 'FAILED'} (${precheck})`);
  if (out) console.log(out.split('\n').map((l) => `  | ${l}`).join('\n'));
} else add('WARN', 'PLAYGAMA', 'official Playgama precheck not found (install plugin playgama-developer-cabinet); factory checks only');

console.log(`Build: ${files.length} files, ${(total / 1048576).toFixed(2)} MB, audio files: ${audio.length}`);
for (const r of rows) console.log(`${r.level.padEnd(4)} [${r.rule}] ${r.msg}`);
const failed = rows.some((r) => r.level === 'FAIL');
console.log(failed ? 'VALIDATION FAILED' : 'VALIDATION PASSED');
process.exit(failed ? 1 : 0);

function findOfficialPrecheck() {
  if (process.env.PLAYGAMA_PRECHECK && fs.existsSync(process.env.PLAYGAMA_PRECHECK)) return process.env.PLAYGAMA_PRECHECK;
  const roots = [path.join(os.homedir(), '.claude', 'plugins')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 4000) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const f = path.join(d, e.name);
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') stack.push(f);
        else if (e.name === 'precheck.mjs' && /playgama-publish[\\/]scripts$/.test(d)) return f;
      }
    }
  }
  return null;
}
