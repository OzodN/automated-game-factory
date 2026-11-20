// @ts-check
/**
 * Shell command semantics for the PreToolUse guard (FX-05, FD-04): which simple commands a command line runs,
 * in which directory, what each of them WRITES or DELETES, whether it runs the factory CLI, what git does, and
 * whether the whole line is UNDERSTOOD.
 *
 * Design principle (fail closed): the precise rules may only RELAX the old coarse text rules for command lines
 * the guard fully understands. A line is understood only when the lexer stayed in sync with the real shell and
 * every simple command is from a small known set whose arguments are data (readers such as cat/grep/ls, the
 * modelled writers cp/mv/mkdir/tee/..., cd, git with understood subcommands, node running a script file). Any
 * shell or interpreter that runs code from a string, a pipe or stdin (bash/sh/pwsh/cmd/eval/source/iex/xargs/
 * find -exec/env -S/npx/inline `node -e`, ...) makes the line not understood, and the guard then applies the old
 * text rules unchanged (guard.mjs legacyShellDeny), in addition to the precise ones.
 */
import path from 'node:path';
import { norm } from './core.mjs';
import { parseShellFull, normalizeCommand, positionals, optionValue, commandName } from './shell.mjs';

/** @typedef {import('./shell.mjs').Word} Word */
/**
 * @typedef {{name: string, args: Word[], words: Word[], env: string[], viaXargs: boolean, wrappers: string[], raw: string,
 *   redirs: import('./shell.mjs').Redir[], dir: string|null, script: string, stdin: string[], dialect: string, unknownOpts: string[], piped: boolean}} Cmd
 */

const CD_NAMES = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
const POPD_NAMES = new Set(['popd', 'pop-location']);

/**
 * Resolve a directory / path argument against the current directory. Returns null (unknown) when it cannot be
 * resolved statically: empty (home), `~`, or containing `$`, backticks, `%`, parentheses or glob characters.
 * @param {string} raw @param {string|null} dir
 */
export function resolvePath(raw, dir) {
  let t = String(raw ?? '').trim();
  if (/^"[^"]*"$|^'[^']*'$/.test(t)) t = t.slice(1, -1);
  if (!t || t.startsWith('~') || /[$`%()*?[\]{}]/.test(t)) return null;
  if (process.platform === 'win32') t = t.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  if (path.isAbsolute(t)) return norm(t);
  return dir === null ? null : norm(path.resolve(dir, t));
}

/**
 * Target directory of a cd-like command (`cd -P x`, `cd /d x`, `Set-Location -Path x`); null when unknown.
 * @param {Word[]} args @param {string|null} dir
 */
function cdTarget(args, dir) {
  const a = args.filter((w) => !/^(\/d|-(LiteralPath|Path)|-[LPe@]+|--)$/i.test(w.v));
  if (!a.length) return null; // `cd` alone: home
  if (a[0].v === '-' || a.length > 1) return null;
  return resolvePath(a[0].v, dir);
}

/**
 * Every simple command a command line runs, in order, with the directory it runs in (null = unknown), plus the
 * lexer issues. cd/pushd/Set-Location change the directory for the following commands; changes inside a bash
 * subshell or substitution are undone when it ends (never for `{ }` groups or PowerShell); popd makes it unknown.
 * @param {string} src @param {{dialect?: 'bash'|'powershell', cwd?: string|null}} [opts]
 * @returns {{cmds: Cmd[], issues: string[]}}
 */
export function parseCommands(src, opts = {}) {
  const text = String(src ?? '');
  const dialect = opts.dialect === 'powershell' ? 'powershell' : 'bash';
  const { entries, issues } = parseShellFull(text, { dialect });
  /** @type {Cmd[]} */
  const cmds = [];
  let dir = opts.cwd ? norm(opts.cwd) : null;
  /** @type {(string|null)[]} */
  const stack = [];
  for (const e of entries) {
    if (e.kind === 'push') { stack.push(dir); continue; }
    if (e.kind === 'pop') { dir = stack.length ? /** @type {string|null} */ (stack.pop()) : dir; continue; }
    const nc = normalizeCommand(e.words);
    const stdin = [...e.heredocs, ...e.redirs.filter((r) => r.op === '<<<' && r.target).map((r) => /** @type {Word} */ (r.target).v)];
    /** @type {string[]} */
    let unknownOpts = [];
    if (dialect === 'powershell') {
      nc.name = PS_ALIASES[nc.name] ?? nc.name;
      const params = PS_PARAMS[nc.name];
      if (params) ({ args: nc.args, unknown: unknownOpts } = canonPsArgs(nc.args, params));
    } else if (BASH_OPTS[nc.name]) {
      unknownOpts = unknownBashOpts(nc.args, BASH_OPTS[nc.name]);
    }
    cmds.push({ ...nc, raw: e.raw, redirs: e.redirs, dir, script: text, stdin, dialect, unknownOpts, piped: e.piped });
    if (CD_NAMES.has(nc.name)) dir = cdTarget(nc.args, dir);
    else if (POPD_NAMES.has(nc.name)) dir = null;
  }
  return { cmds, issues };
}

// ---------------------------------------------------------------- modelled options

/** PowerShell aliases of the modelled writer cmdlets (in the PowerShell tool `cp`, `mv`, `rm` ... are these). */
const PS_ALIASES = /** @type {Record<string, string>} */ ({
  cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item', mv: 'move-item', move: 'move-item', mi: 'move-item',
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', ri: 'remove-item', rmdir: 'remove-item',
  ni: 'new-item', mkdir: 'new-item', md: 'new-item', sc: 'set-content', ac: 'add-content', tee: 'tee-object',
});
const PS_COMMON = ['Confirm', 'WhatIf', 'Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable', 'WarningVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable'];
/** Parameters of the modelled cmdlets (PowerShell accepts any unique prefix, case-insensitive). */
const PS_PARAMS = /** @type {Record<string, string[]>} */ ({
  'copy-item': ['Path', 'LiteralPath', 'Destination', 'Recurse', 'Force', 'Container', 'PassThru', 'Filter', 'Include', 'Exclude', ...PS_COMMON],
  'move-item': ['Path', 'LiteralPath', 'Destination', 'Force', 'PassThru', 'Filter', 'Include', 'Exclude', ...PS_COMMON],
  'remove-item': ['Path', 'LiteralPath', 'Recurse', 'Force', 'Filter', 'Include', 'Exclude', ...PS_COMMON],
  'new-item': ['Path', 'Name', 'ItemType', 'Value', 'Force', ...PS_COMMON],
  'set-content': ['Path', 'LiteralPath', 'Value', 'Encoding', 'Force', 'NoNewline', 'PassThru', ...PS_COMMON],
  'add-content': ['Path', 'LiteralPath', 'Value', 'Encoding', 'Force', 'NoNewline', 'PassThru', ...PS_COMMON],
  'out-file': ['FilePath', 'LiteralPath', 'Encoding', 'Append', 'Force', 'NoClobber', 'Width', 'NoNewline', 'InputObject', ...PS_COMMON],
  'tee-object': ['FilePath', 'LiteralPath', 'Append', 'InputObject', 'Variable', ...PS_COMMON],
});

/**
 * Canonical parameter names (`-Dest` -> `-Destination`, `-dest:x` -> `-Destination` `x`); unknown or ambiguous
 * parameters are returned in `unknown` (the command is then not understood).
 * @param {Word[]} args @param {string[]} params
 */
function canonPsArgs(args, params) {
  /** @type {Word[]} */
  const out = [];
  /** @type {string[]} */
  const unknown = [];
  for (const a of args) {
    const m = !a.quoted && a.v.match(/^-([A-Za-z]+)(?::(.*))?$/);
    if (!m) { out.push(a); continue; }
    const pre = m[1].toLowerCase();
    const exact = params.find((x) => x.toLowerCase() === pre);
    const hits = exact ? [exact] : params.filter((x) => x.toLowerCase().startsWith(pre));
    if (hits.length !== 1) { unknown.push(a.v); out.push(a); continue; }
    out.push({ ...a, v: `-${hits[0]}` });
    if (m[2] !== undefined) out.push({ v: m[2], raw: m[2], quoted: false });
  }
  return { args: out, unknown };
}

/** GNU options the guard models for each bash writer: letters, long names, and options taking a value. */
const BASH_OPTS = /** @type {Record<string, {short: string, long: string[], vshort?: string, vlong?: string[]}>} */ ({
  cp: { short: 'rRfinvpaulsLPHTxd', long: ['recursive', 'force', 'interactive', 'no-clobber', 'verbose', 'preserve', 'archive', 'update', 'link', 'symbolic-link', 'dereference', 'no-dereference', 'parents', 'no-target-directory', 'one-file-system'], vshort: 't', vlong: ['target-directory'] },
  mv: { short: 'finvuT', long: ['force', 'interactive', 'no-clobber', 'verbose', 'update', 'no-target-directory'], vshort: 't', vlong: ['target-directory'] },
  mkdir: { short: 'pv', long: ['parents', 'verbose'], vshort: 'm', vlong: ['mode'] },
  touch: { short: 'acm', long: ['no-create'] },
  rm: { short: 'rRfidv', long: ['recursive', 'force', 'interactive', 'dir', 'verbose', 'one-file-system', 'preserve-root', 'no-preserve-root'] },
  rmdir: { short: 'pv', long: ['parents', 'verbose', 'ignore-fail-on-non-empty'] },
  tee: { short: 'ai', long: ['append', 'ignore-interrupts'] },
});

/** Options of a bash writer the guard does not model (anywhere on the line: GNU accepts options after paths). */
function unknownBashOpts(args, spec) {
  const bad = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (args[k].quoted && !/^-/.test(args[k].raw)) continue;
    if (v === '--') break;
    if (/^--/.test(v)) {
      const [nm, val] = v.slice(2).split('=');
      if (spec.long.includes(nm) && val === undefined) continue;
      if (spec.vlong?.includes(nm)) { if (val === undefined) k++; continue; }
      if (nm === 'preserve' && spec.long.includes('preserve')) continue;
      bad.push(v);
    } else if (/^-./.test(v)) {
      const letters = v.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j];
        if (spec.vshort?.includes(ch)) { if (j === letters.length - 1) k++; break; }
        if (!spec.short.includes(ch)) { bad.push(v); break; }
      }
    }
  }
  return bad;
}

/** Positionals of a bash writer without the values of its value options (`-t DIR`). */
function bashPositionals(args, spec) {
  const out = [];
  let opts = true;
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (opts && v === '--') { opts = false; continue; }
    if (opts && /^--/.test(v)) { const [nm, val] = v.slice(2).split('='); if (spec?.vlong?.includes(nm) && val === undefined) k++; continue; }
    if (opts && /^-./.test(v) && !args[k].quoted) { if (spec?.vshort && spec.vshort.includes(v[v.length - 1]) && v.length >= 2) k++; continue; }
    out.push(args[k]);
  }
  return out;
}

/** The commands only (tests, helpers). @param {string} src @param {{dialect?: 'bash'|'powershell', cwd?: string|null}} [opts] */
export function shellCommands(src, opts = {}) {
  return parseCommands(src, opts).cmds;
}

// ---------------------------------------------------------------- understood?

/** Commands whose arguments are data and that write nothing except through redirections. */
const READERS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'ls', 'wc', 'diff', 'cmp', 'sort', 'cut', 'tr', 'nl', 'file', 'stat',
  'du', 'df', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[', 'which', 'basename', 'dirname', 'realpath',
  'readlink', 'sleep', 'sha256sum', 'sha1sum', 'md5sum', 'column', 'comm', 'paste', 'fold', 'od', 'hexdump', 'strings', 'jq', 'rg',
  'get-content', 'gc', 'select-string', 'sls', 'get-childitem', 'gci', 'dir', 'select-object', 'measure-object', 'measure',
  'format-table', 'ft', 'format-list', 'fl', 'write-host', 'write-output', 'test-path', 'resolve-path', 'get-location', 'gl',
  'get-item', 'gi', 'get-filehash', 'sort-object', 'group-object', 'out-string', 'convertfrom-json', 'convertto-json', 'compare-object',
]);
/** Writers whose targets writeTargets()/deleteTargets() model exactly. */
const MODELLED_WRITERS = new Set([
  'cp', 'mv', 'mkdir', 'touch', 'rm', 'rmdir', 'tee', 'sed', 'tar', 'unzip', 'find',
  'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'new-item', 'ni', 'set-content', 'add-content', 'ac', 'out-file',
  'tee-object', 'remove-item', 'ri', 'del', 'erase', 'rd',
]);
const GIT_UNDERSTOOD = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'merge-base', 'rev-list', 'blame', 'grep', 'describe',
  'shortlog', 'cat-file', 'branch', 'stash', 'add', 'commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'restore',
  'checkout', 'switch', 'mv', 'rm', 'apply', 'am', 'clean',
]);
/** node options understood before the script; the ones in NODE_VALUE_OPTS take the next word as value. */
const NODE_FLAGS = new Set(['--test', '--no-warnings', '--enable-source-maps', '--trace-warnings', '--test-only', '--experimental-strip-types', '--no-experimental-strip-types', '--experimental-vm-modules', '--trace-uncaught', '--stack-trace-limit']);
const NODE_VALUE_OPTS = new Set(['-r', '--require', '--import', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-concurrency', '--disable-warning', '--env-file']);

/** True when a sed invocation only prints / substitutes (no e/w/r commands, no script file). @param {Word[]} args */
function sedSafe(args) {
  if (args.some((w) => /^(-f|--file)/.test(w.v))) return false;
  const scripts = [];
  for (let k = 0; k < args.length; k++) {
    if (/^(-e|--expression)$/.test(args[k].v)) scripts.push(args[++k]?.v ?? '');
    else if (/^--expression=/.test(args[k].v)) scripts.push(args[k].v.slice(13));
  }
  if (!scripts.length) {
    const pos = positionals(args);
    if (!pos.length) return false;
    scripts.push(pos[0].v);
  }
  const addr = String.raw`(?:\d+|\$|\/(?:[^/\\]|\\.)*\/)`;
  const range = `(?:${addr}(?:,${addr})?)?\\s*!?\\s*`;
  const simple = new RegExp(`^${range}[pdqn=]$`);
  const subst = new RegExp(`^${range}s(.)(?:(?!\\1)[^\\\\]|\\\\.)*\\1(?:(?!\\1)[^\\\\]|\\\\.)*\\1[gIip0-9]*$`);
  return scripts.every((sc) => sc.split(/[;\n]/).map((x) => x.trim()).filter(Boolean).every((x) => simple.test(x) || subst.test(x)));
}

/** First reason a single command is not understood, or null. @param {Cmd} c */
export function notUnderstood(c) {
  if (c.wrappers.length) return `wrapper ${c.wrappers[0]}`;
  if (!c.name) return c.words.length ? 'empty command word' : null; // pure assignments: understood
  const n = c.name;
  if (CD_NAMES.has(n) || POPD_NAMES.has(n) || READERS.has(n)) {
    if (n === 'rg' && c.args.some((w) => /^--pre(=|$)/.test(w.v))) return 'rg --pre';
    return null;
  }
  if (MODELLED_WRITERS.has(n)) {
    if (c.unknownOpts.length) return `${n} option ${c.unknownOpts[0]} is not modelled`;
    if (n === 'sed' && !sedSafe(c.args)) return 'sed script that is not print/substitute only';
    if (n === 'tar' && c.args.some((w) => /^--(to-command|checkpoint-action|use-compress-program|info-script|new-volume-script|rmt-command|rsh-command|transform|xform)|^-[A-Za-z]*[IF]/.test(w.v))) return 'tar option that runs a program';
    if (n === 'find' && c.args.some((w) => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w.v))) return 'find -exec / -fprint';
    return null;
  }
  if (n === 'git') {
    const g = gitInfo(c);
    if (!g) return 'git';
    if (g.configs) return 'git -c / --config-env';
    if (!GIT_UNDERSTOOD.has(g.sub)) return `git ${g.sub || '(no subcommand)'}`;
    if (g.sub === 'rebase' && g.args.some((w) => /^(-x|--exec|-i|--interactive)(=|$)/.test(w.v))) return 'git rebase --exec / -i';
    if (g.args.some((w) => /^--(ext-diff|textconv|upload-pack|receive-pack|exec)(=|$)/.test(w.v))) return 'git option that runs a program';
    return null;
  }
  if (n === 'node') {
    let k = 0;
    for (; k < c.args.length; k++) {
      const v = c.args[k].v;
      if (/^-(e|p|i|pe|ep|c)$|^--(eval|print|interactive|check)(=|$)/.test(v)) return 'node inline code';
      if (v === '--') { k++; break; }
      if (!/^-/.test(v)) break;
      const [opt] = v.split('=');
      if (NODE_VALUE_OPTS.has(opt)) { if (!v.includes('=')) k++; continue; }
      if (NODE_FLAGS.has(opt) || /^--test-/.test(opt)) continue;
      return `node option ${v}`;
    }
    const script = c.args[k];
    if (!script || script.v === '-') return 'node reading code from stdin';
    if (c.stdin.length) return 'node with stdin';
    return null;
  }
  return `command ${n}`;
}

/**
 * Parse a command line and decide whether the guard understands it completely.
 * @param {string} src @param {{dialect?: 'bash'|'powershell', cwd?: string|null}} [opts]
 * @returns {{cmds: Cmd[], understood: boolean, reasons: string[]}}
 */
export function analyzeShell(src, opts = {}) {
  const { cmds, issues } = parseCommands(src, opts);
  const reasons = [...issues];
  for (const c of cmds) {
    const r = notUnderstood(c);
    if (r) reasons.push(r);
  }
  return { cmds, understood: reasons.length === 0, reasons };
}

/** Commands that run code taken from a string, stdin, a pipe or a file argument. */
const CODE_RUNNERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'eval', 'source', '.', 'iex', 'invoke-expression',
  'invoke-command', 'icm', 'start-process', 'saps', 'start-job', 'node', 'bun', 'deno', 'python', 'python3', 'py', 'perl',
  'ruby', 'php', 'lua', 'awk', 'gawk', 'xargs', 'npx', 'pnpm', 'npm', 'yarn', 'corepack', 'tsx', 'ts-node', 'osascript', 'wsl', 'busybox',
]);
/** Broad write / spawn indicators in any text (used only for lines that are not understood). */
export const WRITE_OR_SPAWN_HINT = /write|append|copy|rename|unlink|\brm\b|rmdir|mkdir|\btouch\b|\btee\b|\bcp\b|\bmv\b|\bdd\b|truncate|symlink|createWriteStream|exec|spawn|fork|system|popen|subprocess|child_process|shutil|open\s*\(|New-Item|Out-File|Set-Content|Add-Content|Copy-Item|Move-Item|Remove-Item|sed\s+-i|>/i;

/** True when a command of the line runs code from somewhere (shell, interpreter, xargs, find -exec, wrapper). @param {Cmd[]} cmds */
export function runsCode(cmds) {
  return cmds.some((c) => c.wrappers.length || CODE_RUNNERS.has(c.name) || c.words.some((w, k) => k === 0 && CODE_RUNNERS.has(commandName(w.v))) ||
    (c.name === 'find' && c.args.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w.v))));
}

// ---------------------------------------------------------------- writes and deletes

const NULL_SINKS = /^(\/dev\/(null|stdout|stderr|tty|fd\/\d+)|nul|\$null|con)$/i;
const PS_VALUE_OPTS = ['-Value', '-InputObject', '-Encoding', '-ItemType', '-Stream', '-Filter', '-Include', '-Exclude', '-Delimiter', '-Width'];
const ALL_ARGS_WRITERS = new Set([
  'mkdir', 'md', 'touch', 'truncate', 'chmod', 'chown', 'shred', 'ln',
  'out-file', 'set-content', 'sc', 'add-content', 'ac', 'new-item', 'ni', 'clear-content', 'clc', 'rename-item', 'rni', 'ren',
  'export-csv', 'export-clixml', 'new-itemproperty', 'set-itemproperty',
]);
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'remove-item', 'ri']);
const COPIERS = new Set(['cp', 'install', 'scp', 'copy', 'copy-item', 'cpi', 'robocopy', 'xcopy']);
/** Movers change their SOURCES too (the source disappears). */
const MOVERS = new Set(['mv', 'move', 'move-item', 'mi']);
/** Write or process-spawn indicators in inline code (`node -e`, `python -c`, ...), judged together with a path mention. */
const CODE_WRITE_HINT = /write|append|copy|rename|unlink|\brm|rmdir|mkdir|truncate|symlink|createWriteStream|exec|spawn|fork|system|popen|subprocess|child_process|shutil|open\s*\(|Out-File|Set-Content|>/i;
const INLINE_FLAGS = { node: /^(-e|-p|-pe|-ep|--eval|--print)(=|$)/, deno: /^eval$/, bun: /^(-e|--eval|-p|--print)(=|$)/, python: /^-c$/, python3: /^-c$/, py: /^-c$/, perl: /^-[a-zA-Z]*[eE]$/, ruby: /^-e$/ };

/** @param {Word[]} args */
const nonValuePositionals = (args) => {
  const skip = new Set();
  for (const nm of PS_VALUE_OPTS) {
    const k = args.findIndex((w) => w.v.toLowerCase() === nm.toLowerCase());
    if (k >= 0) skip.add(k + 1);
  }
  return positionals(args.filter((_, k) => !skip.has(k)));
};

/**
 * Locations a command writes to (files or directories, including the sources of a move), as words. Inline code
 * with a write or spawn indicator is returned as one pseudo word (it is judged by its path mentions).
 * @param {Cmd} c
 * @returns {Word[]}
 */
export function writeTargets(c) {
  /** @type {Word[]} */
  const t = [];
  for (const r of c.redirs) {
    if (!r.target || r.op === '<' || r.op === '<<<') continue;
    if (r.op === '>&' && /^(\d+|-)$/.test(r.target.v)) continue; // fd duplication (2>&1, >&2)
    if (NULL_SINKS.test(r.target.v)) continue;
    t.push(r.target);
  }
  const { name, args } = c;
  if (!name) return t;
  if (c.viaXargs) t.push({ v: c.script, raw: c.script, quoted: false });
  if (name === 'tee' || name === 'tee-object') {
    const fp = optionValue(args, ['-FilePath', '-Path', '-LiteralPath']);
    t.push(...(fp ? [fp] : positionals(args)));
  } else if (ALL_ARGS_WRITERS.has(name) || DELETERS.has(name)) {
    t.push(...nonValuePositionals(args));
    const pv = optionValue(args, ['-Path', '-LiteralPath', '-FilePath', '-Destination']);
    if (pv) t.push(pv);
  } else if (MOVERS.has(name) || (name === 'rsync' && args.some((w) => w.v === '--remove-source-files'))) {
    t.push(...nonValuePositionals(args));
    for (const o of ['-t', '--target-directory', '-Destination', '-Path', '-LiteralPath']) { const v = optionValue(args, [o]); if (v) t.push(v); }
  } else if (name === 'copy-item' || name === 'cpi' || name === 'copy') {
    // PowerShell: positional 0 = Path, 1 = Destination. Every positional that is not the bound source may be the
    // destination (fail closed); the canonical -Destination value always is.
    const dest = optionValue(args, ['-Destination']);
    if (dest) t.push(dest);
    const valued = /^-(Path|LiteralPath|Destination|Filter|Include|Exclude|ErrorAction|WarningAction|InformationAction|ErrorVariable|WarningVariable|OutVariable|OutBuffer|PipelineVariable)$/i;
    const pos = positionals(args.filter((_, k) => !(k > 0 && valued.test(args[k - 1].v) && !args[k - 1].quoted)));
    const hasPath = args.some((w) => /^-(Path|LiteralPath)$/i.test(w.v));
    t.push(...(hasPath ? pos : pos.slice(1)));
  } else if (COPIERS.has(name) || name === 'rsync') {
    // GNU: options may follow the paths; with -t every positional is a source, otherwise every positional after
    // the first may be the destination (fail closed).
    const dest = optionValue(args, ['-t', '--target-directory']);
    if (dest) t.push(dest);
    else {
      const pos = bashPositionals(args, BASH_OPTS[name]).filter((w) => !/^\/[A-Za-z]+(:\S*)?$/.test(w.v) || !['robocopy', 'xcopy'].includes(name));
      t.push(...pos.slice(1));
    }
  } else if (name === 'tar') {
    const first = args[0]?.v || '';
    const bundles = args.filter((w) => /^-[A-Za-z]+$/.test(w.v)).map((w) => w.v.slice(1)).join('') + (/^[A-Za-z]+$/.test(first) ? first : '');
    const extract = /x/.test(bundles) || args.some((w) => /^--(extract|get)$/.test(w.v));
    const create = /[cruA]/.test(bundles) || args.some((w) => /^--(create|append|update|concatenate|delete)$/.test(w.v));
    const C = optionValue(args, ['-C', '--directory']);
    if (extract) t.push(C ?? { v: '.', raw: '.', quoted: false });
    if (create) {
      const f = optionValue(args, ['-f', '--file']) ?? (() => {
        const k = args.findIndex((w) => /^-?[A-Za-z]*f$/.test(w.v) && /f/.test(w.v));
        return k >= 0 ? args[k + 1] ?? null : null;
      })();
      if (f) t.push(f);
    }
  } else if (name === 'unzip') {
    t.push(optionValue(args, ['-d']) ?? { v: '.', raw: '.', quoted: false });
  } else if (name === 'expand-archive') {
    const d = optionValue(args, ['-DestinationPath']);
    if (d) t.push(d);
    else { const pos = nonValuePositionals(args); if (pos[1]) t.push(pos[1]); }
  } else if (name === 'sed' || name === 'perl') {
    const inPlace = args.some((w) => /^-[a-zA-Z]*i/.test(w.v) || /^--in-place/.test(w.v));
    if (inPlace) {
      const hasScriptOpt = args.some((w) => /^(-e|-f|--expression|--file)/.test(w.v) || (name === 'perl' && /^-[a-zA-Z]*[eE]$/.test(w.v)));
      const pos = positionals(args.filter((w, k) => !(k > 0 && /^(-e|-f|--expression|--file|-[a-zA-Z]*[eE])$/.test(args[k - 1].v))));
      t.push(...(hasScriptOpt ? pos : pos.slice(1)));
    }
  } else if (name === 'sort') {
    const o = optionValue(args, ['-o', '--output']);
    if (o) t.push(o);
  } else if (name === 'dd') {
    for (const a of args) if (/^of=/.test(a.v)) t.push({ ...a, v: a.v.slice(3), raw: a.raw.replace(/^of=/, '') });
  } else if (name === 'find') {
    if (args.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(w.v))) t.push(...args.filter((w) => !/^-/.test(w.v)).slice(0, 1));
  } else if (name === 'curl' || name === 'wget') {
    const o = optionValue(args, ['-o', '--output', '-O', '--output-document', '-P', '--directory-prefix']);
    if (o) t.push(o);
  } else if (name in INLINE_FLAGS) {
    const re = /** @type {Record<string, RegExp>} */ (INLINE_FLAGS)[name];
    const k = args.findIndex((w) => re.test(w.v));
    const pos = positionals(args);
    let code = '';
    if (k >= 0) code = args[k].v.includes('=') ? args[k].v.slice(args[k].v.indexOf('=') + 1) : args[k + 1]?.v ?? '';
    else if (!pos.length || pos[0].v === '-') code = c.stdin.join('\n');
    if (code && CODE_WRITE_HINT.test(code)) t.push({ v: code, raw: code, quoted: true }, ...(k >= 0 ? args.slice(k + 2) : pos));
  }
  // Generic long output options of any tool (`git diff --output=x`, `--log-file x`).
  const lo = optionValue(args, ['--output', '--output-file', '--out-file', '--outfile', '--log-file']);
  if (lo && !t.includes(lo)) t.push(lo);
  return t;
}

/** Copiers: their first plain positional is a source that is only read. */
const COPY_CLASS = new Set(['cp', 'install', 'ln', 'scp', 'rsync', 'copy', 'copy-item', 'cpi', 'robocopy', 'xcopy', 'unzip', 'expand-archive']);
/** Movers: every token may be written (the source disappears). */
const MOVE_CLASS = new Set(['mv', 'move', 'move-item', 'mi']);

/**
 * Copy/move class (FX-05 re-review): the tokens of a copier or mover that must not mention .factory/.inbox, as
 * whole token text (option bundles, `-t<dir>`, `--x=<dir>`, `-X:<dir>` included). Only the first plain positional
 * of a copier (its read-only source) is exempt; movers, `rsync --remove-source-files` and a Copy-Item fed by a
 * pipeline have no exemption. tar: only the archive named by -f/--file while not creating an archive, and the
 * plain sources while creating one, are exempt. Returns null for other commands.
 * @param {Cmd} c
 * @returns {{tokens: Word[], exempt: Word[]} | null}
 */
export function copyMoveTokens(c) {
  const all = c.args;
  if (MOVE_CLASS.has(c.name) || (c.name === 'rsync' && all.some((w) => w.v === '--remove-source-files'))) return { tokens: all, exempt: [] };
  if (COPY_CLASS.has(c.name)) {
    if (c.piped && ['copy-item', 'cpi', 'copy'].includes(c.name)) return { tokens: all, exempt: [] };
    const first = all.find((w) => !/^[-/]/.test(w.v) || (w.v.startsWith('/') && !/^\/[A-Za-z]+(:\S*)?$/.test(w.v)));
    const k = first ? all.indexOf(first) : -1;
    // A first positional that is the value of a preceding option (e.g. `-t <dir>`, `-Destination <dir>`) is not a source.
    const prev = k > 0 ? all[k - 1].v : '';
    const isValue = /^-(t|S|T|Destination|Dest\w*|DestinationPath|d)$/i.test(prev) || (/^-[a-zA-Z]*[tS]$/.test(prev) && c.dialect !== 'powershell');
    return { tokens: all, exempt: first && !isValue ? [first] : [] };
  }
  if (c.name === 'tar') {
    const first = all[0]?.v || '';
    const bundles = all.filter((w) => /^-[A-Za-z]+$/.test(w.v)).map((w) => w.v.slice(1)).join('') + (/^[A-Za-z]+$/.test(first) ? first : '');
    const create = /[cruA]/.test(bundles) || all.some((w) => /^--(create|append|update|concatenate|delete)$/.test(w.v));
    /** @type {Word[]} */
    const exempt = [];
    all.forEach((w, k) => {
      const prev = k > 0 ? all[k - 1].v : '';
      const isFileValue = prev === '-f' || prev === '--file' || (/^-?[A-Za-z]*f$/.test(prev) && /f/.test(prev) && k > 0 && !/^--/.test(prev));
      if (!create && (isFileValue || /^--file=/.test(w.v))) exempt.push(w);
      if (create && !isFileValue && !/^-/.test(w.v) && !(k === 0 && /^[A-Za-z]+$/.test(w.v))) exempt.push(w);
    });
    return { tokens: all, exempt };
  }
  return null;
}

/** True for a recursive / directory delete (`rm -r`, `rm -rf`, `Remove-Item`, `rmdir`, `rd`, `del`). @param {Cmd} c */
export function isTreeDelete(c) {
  if (c.name === 'rm') return c.args.some((w) => /^-[a-zA-Z]*[rR]/.test(w.v) || w.v === '--recursive');
  return ['rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri'].includes(c.name) ||
    (c.name === 'find' && c.args.some((w) => w.v === '-delete' || /^-(exec|execdir)$/.test(w.v)));
}

/** Delete targets of a tree delete (all path arguments). @param {Cmd} c @returns {Word[]} */
export function deleteTargets(c) {
  if (!isTreeDelete(c)) return [];
  if (c.viaXargs) return [{ v: c.script, raw: c.script, quoted: false }];
  const pos = c.name === 'find' ? c.args.filter((w) => !/^-/.test(w.v)).slice(0, 1) : nonValuePositionals(c.args);
  const pv = optionValue(c.args, ['-Path', '-LiteralPath']);
  return pv ? [...pos, pv] : pos;
}

// ---------------------------------------------------------------- factory CLI

/** Commands that may run a script given as an argument. */
const RUNNERS = new Set(['node', 'bun', 'deno', 'npx', 'pnpm', 'corepack', 'npm', 'yarn', 'start-process', 'saps', 'tsx', 'ts-node']);

/**
 * When the command runs the factory CLI, its argument string (what follows factory.mjs); otherwise null.
 * Fail closed: for node and every other script runner (bun, deno, npx, pnpm exec, Start-Process, ...) ANY argument
 * that names or resolves to factory/cli/factory.mjs counts. Reads such as cat / grep / git diff of the file do not.
 * @param {Cmd} c
 */
export function cliInvocation(c) {
  if (!RUNNERS.has(c.name)) return null;
  for (let k = 0; k < c.args.length; k++) {
    const a = c.args[k];
    // Start-Process node -ArgumentList 'factory/cli/factory.mjs gate ...': the path may be inside a longer word.
    const text = [a.v, a.raw].map((x) => x.replace(/\\/g, '/'));
    const resolved = resolvePath(a.v, c.dir);
    const hit = text.some((f) => /(^|[\/\s"'=])factory\/cli\/factory\.mjs(?=$|[\s"'])/i.test(f)) ||
      (resolved && /\/factory\/cli\/factory\.mjs$/i.test(resolved));
    if (!hit) continue;
    const inWord = text[0].replace(/^.*?factory\/cli\/factory\.mjs/i, '').trim();
    return [inWord, ...c.args.slice(k + 1).map((w) => w.v)].join(' ').trim();
  }
  return null;
}

// ---------------------------------------------------------------- git

const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--list-cmds']);
export const GIT_WRITE_SUBCMDS = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'reset', 'restore', 'checkout', 'switch', 'stash', 'add', 'rm', 'mv', 'apply', 'pull', 'clean']);

/**
 * git invocation details: global options (any, including ones with space-separated values), subcommand and args.
 * @param {Cmd} c
 * @returns {{sub: string, args: Word[], C: string[], gitDir: boolean, workTree: boolean, configs: boolean, write: boolean} | null}
 */
export function gitInfo(c) {
  if (c.name !== 'git') return null;
  /** @type {string[]} */
  const C = [];
  let gitDir = c.env.includes('GIT_DIR');
  let workTree = c.env.includes('GIT_WORK_TREE');
  let configs = false;
  let k = 0;
  for (; k < c.args.length; k++) {
    const v = c.args[k].v;
    if (!/^-/.test(v)) break;
    const [opt] = v.split('=');
    if (opt === '--git-dir') gitDir = true;
    if (opt === '--work-tree') workTree = true;
    if (opt === '-c' || opt === '--config-env' || /^-c./.test(v)) configs = true;
    if (GIT_VALUE_GLOBALS.has(v)) {
      if (v === '-C' && c.args[k + 1]) C.push(c.args[k + 1].v);
      k++;
    }
  }
  const sub = c.args[k]?.v ?? '';
  const args = c.args.slice(k + 1);
  let write = GIT_WRITE_SUBCMDS.has(sub);
  if (sub === 'stash' && /^(list|show)$/.test(args[0]?.v ?? '')) write = false;
  if (sub === 'clean' && args.some((w) => w.v === '--dry-run' || /^-[a-zA-Z]*n/.test(w.v))) write = false;
  return { sub, args, C, gitDir, workTree, configs, write };
}

/**
 * True when the command line sets GIT_DIR / GIT_WORK_TREE for later commands
 * (`export GIT_DIR=…`, `GIT_DIR=… ;`, `$env:GIT_DIR = …`, `set GIT_DIR=…`).
 * @param {Cmd[]} cmds
 */
export function setsGitEnv(cmds) {
  const re = /^(\$env:)?GIT_(DIR|WORK_TREE)(=|$)/i;
  return cmds.some((c) => (!c.name && c.env.some((e) => /^GIT_(DIR|WORK_TREE)$/.test(e))) ||
    (['export', 'set', 'setx', 'declare', 'typeset', 'local', 'readonly'].includes(c.name) && c.args.some((w) => re.test(w.v))) ||
    (c.words[0] && re.test(c.words[0].v)) || (c.name === 'set-item' && c.args.some((w) => /env:GIT_(DIR|WORK_TREE)/i.test(w.v))));
}
