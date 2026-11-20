// @ts-check
/**
 * A small, dependency-free shell command lexer for the PreToolUse guard (FX-05, FD-04).
 *
 * It splits a Bash or PowerShell command line into simple commands WITHOUT splitting inside quoted strings,
 * heredoc bodies or PowerShell here-strings, and separates output redirections from the command words.
 * Command substitutions (`$(...)`, backticks, `<(...)`) and subshells / script blocks are parsed recursively,
 * so the commands they run are judged too; their text is never treated as data of the outer command.
 *
 * It is not a full shell grammar. It is deliberately conservative where it has to guess: an unterminated
 * quote runs to the end of the input (as the shells do), a heredoc delimiter line is matched after trimming
 * (ending a body earlier only exposes more text to the guard), and parse errors never happen (every input
 * produces a command list).
 *
 * Output: an ordered list of entries. Commands of a substitution come before the command that contains it.
 *   { kind: 'cmd', words: Word[], redirs: Redir[], raw: string, heredocs: string[], piped: boolean }  (heredoc bodies: stdin data; piped: reads a pipe)
 *   { kind: 'push' } / { kind: 'pop' }   — a subshell / substitution / script block begins / ends
 *                                          (directory changes inside it do not leak out)
 * Word  = { v: string (quotes and escapes removed), raw: string (source text), quoted: boolean }
 * Redir = { op: '>' | '>>' | '>|' | '>&' | '&>' | '&>>' | '<' | '<<<', fd: string|null, target: Word|null }
 */

/** @typedef {{v: string, raw: string, quoted: boolean}} Word */
/** @typedef {{op: string, fd: string|null, target: Word|null}} Redir */
/** @typedef {{kind: 'cmd', words: Word[], redirs: Redir[], raw: string, heredocs: string[], piped: boolean} | {kind: 'push'} | {kind: 'pop'}} Entry */

/**
 * @param {string} src
 * @param {{dialect?: 'bash'|'powershell'}} [opts]
 * @returns {Entry[]}
 */
export function parseShell(src, opts = {}) {
  return parseShellFull(src, opts).entries;
}

/**
 * Like parseShell, plus `issues`: every place where the lexer could not stay in sync with the real shell
 * (unterminated quote / substitution / heredoc / here-string, unbalanced parenthesis, PowerShell typographic
 * quotes). A caller must not rely on the entries of an input with issues (fail closed).
 * @param {string} src
 * @param {{dialect?: 'bash'|'powershell'}} [opts]
 * @returns {{entries: Entry[], issues: string[]}}
 */
export function parseShellFull(src, opts = {}) {
  const ps = opts.dialect === 'powershell';
  const s = String(src ?? '');
  const n = s.length;
  /** @type {Entry[]} */
  const out = [];
  /** @type {string[]} */
  const issues = [];
  // PowerShell treats U+2018..U+201E as quote characters; this lexer does not model them.
  if (ps && /[‘-„]/.test(s)) issues.push('typographic quote characters');
  /** @type {{delim: string, strip: boolean, into: string[]}[]} */
  const heredocs = [];
  let i = 0;

  /** Skip the bodies of pending heredocs (kept as data on their command); `i` is just after a newline. */
  function skipHeredocBodies() {
    while (heredocs.length) {
      const h = /** @type {{delim: string, strip: boolean, into: string[]}} */ (heredocs.shift());
      const body = [];
      let closed = false;
      while (i < n) {
        let j = s.indexOf('\n', i);
        if (j < 0) j = n;
        const line = s.slice(i, j).replace(/\r$/, '');
        i = Math.min(j + 1, n);
        if ((h.strip ? line.replace(/^\t+/, '') : line).trim() === h.delim) { closed = true; break; }
        body.push(line);
      }
      if (!closed) issues.push(`unterminated heredoc ${h.delim}`);
      h.into.push(body.join('\n'));
    }
  }

  /** Read a heredoc delimiter word after `<<` / `<<-` (quotes removed). */
  function readDelimiter() {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    let d = '';
    while (i < n && !/[\s;&|<>()]/.test(s[i])) {
      const c = s[i];
      if (c === "'" || c === '"') {
        const e = s.indexOf(c, i + 1);
        d += s.slice(i + 1, e < 0 ? n : e);
        i = e < 0 ? n : e + 1;
      } else if (c === '\\' && !ps) {
        d += s[i + 1] ?? '';
        i += 2;
      } else {
        d += c;
        i++;
      }
    }
    return d;
  }

  /**
   * Parse a command list until `term` (')', '`', '}' or null for end of input).
   * @param {string|null} term
   */
  function parseList(term) {
    /** @type {{words: Word[], redirs: Redir[], start: number, heredocs: string[], piped?: boolean}} */
    let cmd = { words: [], redirs: [], start: i, heredocs: [], piped: false };
    /** @type {{v: string, start: number, quoted: boolean} | null} */
    let word = null;
    /** @type {Redir|null} */
    let redir = null;

    const startWord = () => {
      if (!word) word = { v: '', start: i, quoted: false };
      return word;
    };
    const endWord = () => {
      if (!word) return;
      const w = { v: word.v, raw: s.slice(word.start, i), quoted: word.quoted };
      word = null;
      if (redir) {
        redir.target = w;
        cmd.redirs.push(redir);
        redir = null;
      } else cmd.words.push(w);
    };
    const endCmd = (end = i) => {
      endWord();
      if (redir) {
        cmd.redirs.push(redir);
        redir = null;
      }
      if (cmd.words.length || cmd.redirs.length) out.push({ kind: 'cmd', words: cmd.words, redirs: cmd.redirs, raw: s.slice(cmd.start, end).trim(), heredocs: cmd.heredocs, piped: !!cmd.piped });
      cmd = { words: [], redirs: [], start: i, heredocs: [], piped: false };
    };
    /**
     * Nested list. `isolate`: a bash subshell / substitution (`( )`, `$( )`, backticks, `<( )`) whose directory
     * changes do not leak out; bash `{ }` groups and every PowerShell construct share the caller's location.
     * @param {string} t @param {boolean} isolate
     */
    const nested = (t, isolate) => {
      const iso = isolate && !ps;
      if (iso) out.push({ kind: 'push' });
      parseList(t);
      if (iso) out.push({ kind: 'pop' });
    };
    /** Begin a redirection; a pending all-digit (or `*`) word directly before it is its file descriptor. */
    const beginRedir = (op, opStart) => {
      let fd = null;
      if (word && !word.quoted && /^(\d+|\*)$/.test(word.v) && s.slice(word.start, opStart) === word.v) {
        fd = word.v;
        word = null;
      }
      endWord();
      if (redir) cmd.redirs.push(redir);
      redir = { op, fd, target: null };
    };

    while (i < n) {
      const c = s[i];
      const c2 = s[i + 1];
      if (term && c === term && !(term === '}' && word)) {
        endCmd();
        i++;
        return;
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        endWord();
        i++;
        continue;
      }
      if (c === '\n') {
        endCmd();
        i++;
        skipHeredocBodies();
        cmd.start = i;
        continue;
      }
      if (c === ';') {
        endCmd();
        i++;
        cmd.start = i;
        continue;
      }
      if (c === '&') {
        if (c2 === '&') {
          endCmd();
          i += 2;
          cmd.start = i;
          continue;
        }
        if (c2 === '>' && !ps) {
          endWord();
          const app = s[i + 2] === '>';
          const at = i;
          i += app ? 3 : 2;
          beginRedir(app ? '&>>' : '&>', at);
          continue;
        }
        if (ps) {
          // PowerShell call operator: `& "C:\nodejs\node.exe" args` -> the next word is the command.
          endWord();
          i++;
          continue;
        }
        endCmd(); // background
        i++;
        cmd.start = i;
        continue;
      }
      if (c === '|') {
        endCmd();
        const orOp = c2 === '|';
        i += orOp || (c2 === '&' && !ps) ? 2 : 1;
        cmd.start = i;
        cmd.piped = !orOp; // the next command reads the previous one's output
        continue;
      }
      if (c === '(' && !word) {
        endCmd();
        i++;
        nested(')', true);
        cmd.start = i;
        continue;
      }
      if (c === ')' || (c === '}' && !word)) {
        // Unbalanced closing parenthesis / brace (no open list).
        issues.push(`unbalanced ${c}`);
        endCmd();
        i++;
        cmd.start = i;
        continue;
      }
      if (c === '{' && !word && (c2 === undefined || /[\s]/.test(c2) || ps)) {
        endCmd();
        i++;
        nested('}', false);
        cmd.start = i;
        continue;
      }
      if (c === '#' && !word) {
        while (i < n && s[i] !== '\n') i++;
        continue;
      }
      if (c === '<' && c2 === '#' && ps) {
        const e = s.indexOf('#>', i + 2);
        if (e < 0) issues.push('unterminated <#');
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (c === '>') {
        let op = '>';
        let k = i + 1;
        if (s[k] === '>') { op = '>>'; k++; }
        else if (s[k] === '|') { op = '>|'; k++; }
        else if (s[k] === '&') { op = '>&'; k++; }
        const at = i;
        i = k;
        beginRedir(op, at);
        continue;
      }
      if (c === '<') {
        if (c2 === '(' && !ps) {
          endWord();
          i += 2;
          nested(')', true);
          continue;
        }
        if (c2 === '<' && s[i + 2] === '<') {
          const at = i;
          i += 3;
          beginRedir('<<<', at);
          continue;
        }
        if (c2 === '<' && !ps) {
          endWord();
          i += 2;
          const strip = s[i] === '-';
          if (strip) i++;
          const delim = readDelimiter();
          if (delim) heredocs.push({ delim, strip, into: cmd.heredocs });
          continue;
        }
        const at = i;
        i++;
        beginRedir('<', at);
        continue;
      }
      if (c === '$' && c2 === "'" && !ps) {
        // Bash ANSI-C quoting $'...': backslash escapes (including \') inside.
        const w = startWord();
        w.quoted = true;
        i += 2;
        let closed = false;
        while (i < n) {
          if (s[i] === '\\') { w.v += s[i + 1] ?? ''; i += 2; continue; }
          if (s[i] === "'") { i++; closed = true; break; }
          w.v += s[i++];
        }
        if (!closed) issues.push("unterminated $'");
        continue;
      }
      if (c === "'") {
        const w = startWord();
        w.quoted = true;
        i++;
        let closed = false;
        while (i < n) {
          if (s[i] === "'") {
            if (ps && s[i + 1] === "'") { w.v += "'"; i += 2; continue; }
            i++;
            closed = true;
            break;
          }
          w.v += s[i++];
        }
        if (!closed) issues.push("unterminated '");
        continue;
      }
      if (c === '"') {
        const w = startWord();
        w.quoted = true;
        i++;
        let closed = false;
        while (i < n) {
          const d = s[i];
          if (d === '"') {
            if (ps && s[i + 1] === '"') { w.v += '"'; i += 2; continue; }
            i++;
            closed = true;
            break;
          }
          if (d === '\\' && !ps) {
            const e = s[i + 1];
            if (e === '\n') { i += 2; continue; }
            if (e !== undefined && '$`"\\'.includes(e)) { w.v += e; i += 2; continue; }
            w.v += d;
            i++;
            continue;
          }
          if (d === '`') {
            if (ps) { w.v += s[i + 1] ?? ''; i += 2; continue; }
            i++;
            nested('`', true);
            w.v += '$(…)';
            continue;
          }
          if (d === '$' && s[i + 1] === '(') {
            i += 2;
            nested(')', true);
            w.v += '$(…)';
            continue;
          }
          w.v += d;
          i++;
        }
        if (!closed) issues.push('unterminated "');
        continue;
      }
      if (c === '`') {
        if (ps) {
          const w = startWord();
          if (c2 === '\n') { i += 2; continue; }
          w.v += c2 ?? '';
          i += 2;
          continue;
        }
        const w = startWord();
        i++;
        nested('`', true);
        w.v += '$(…)';
        continue;
      }
      if (c === '\\' && !ps) {
        if (c2 === '\n') { i += 2; continue; }
        const w = startWord();
        w.v += c2 ?? '';
        i += 2;
        continue;
      }
      if (c === '$' && c2 === '(') {
        const w = startWord();
        i += 2;
        nested(')', true);
        w.v += '$(…)';
        continue;
      }
      if (c === '@' && ps && !word && (c2 === '(' || c2 === '{')) {
        endCmd();
        i += 2;
        nested(c2 === '(' ? ')' : '}', false);
        cmd.start = i;
        continue;
      }
      if (c === '@' && ps && !word && (c2 === "'" || c2 === '"')) {
        // PowerShell here-string: @'<newline> ... <newline>'@
        const close = `\n${c2}@`;
        const e = s.indexOf(close, i + 2);
        const w = startWord();
        w.quoted = true;
        w.v += s.slice(i + 2, e < 0 ? n : e).replace(/^[ \t]*\r?\n/, '');
        if (e < 0) issues.push('unterminated here-string');
        i = e < 0 ? n : e + close.length;
        continue;
      }
      if (c === '$' && c2 === '{' && !ps) {
        const w = startWord();
        const e = s.indexOf('}', i + 2);
        // ${...} is kept as text; a substitution or nested brace inside it is not modelled.
        if (e < 0 || /[`{]|\$\(/.test(s.slice(i + 2, e))) issues.push('complex ${...} expansion');
        w.v += s.slice(i, e < 0 ? n : e + 1);
        i = e < 0 ? n : e + 1;
        continue;
      }
      startWord().v += c;
      i++;
    }
    if (term) issues.push(`unterminated ${term === ')' ? '(' : term === '}' ? '{' : term}`);
    endCmd();
  }

  while (i < n) parseList(null);
  if (heredocs.length) issues.push('heredoc without body');
  return { entries: out, issues };
}

// ---------------------------------------------------------------- command helpers

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin', 'xargs', 'timeout', 'stdbuf']);

/** Lower-case command name without directory and `.exe` / `.cmd` / `.bat` / `.ps1`. @param {string} v */
export function commandName(v) {
  return String(v || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '') ?? '';
}

/**
 * Strip leading variable assignments and wrapper commands (`env`, `sudo`, `xargs`, ...).
 * @param {Word[]} words
 * `wrappers` lists the wrapper commands that were stripped (a wrapped command is never "understood" by the guard).
 * @returns {{name: string, args: Word[], words: Word[], env: string[], viaXargs: boolean, wrappers: string[]}}
 */
export function normalizeCommand(words) {
  let k = 0;
  /** @type {string[]} */
  const env = [];
  /** @type {string[]} */
  const wrappers = [];
  let viaXargs = false;
  for (;;) {
    // `NAME=value` / `NAME="value"`: the name itself is never quoted (checked on the source text).
    while (k < words.length && ASSIGN_RE.test(words[k].raw)) env.push(words[k++].v.split('=')[0]);
    const nm = k < words.length ? commandName(words[k].v) : '';
    if (!WRAPPERS.has(nm)) break;
    wrappers.push(nm);
    if (nm === 'xargs') viaXargs = true;
    k++;
    // Wrapper options (and `timeout <duration>`); `env -u NAME`, `xargs -I {}` / `-n 1` take a value.
    while (k < words.length && /^-/.test(words[k].v)) {
      const o = words[k++].v;
      if (/^-(u|I|n|P|L|s|d|E|a|k|s)$/.test(o) && k < words.length) k++;
    }
    if (nm === 'timeout' && k < words.length && /^\d/.test(words[k].v)) k++;
    if (nm === 'nice' && k < words.length && /^-?\d+$/.test(words[k].v)) k++;
  }
  const rest = words.slice(k);
  return { name: rest.length ? commandName(rest[0].v) : '', args: rest.slice(1), words: rest, env, viaXargs, wrappers };
}

/** Non-option arguments (a lone `--` ends options). @param {Word[]} args */
export function positionals(args) {
  const out = [];
  let opts = true;
  for (const a of args) {
    if (opts && a.v === '--') { opts = false; continue; }
    if (opts && /^-./.test(a.v) && !a.quoted) continue;
    out.push(a);
  }
  return out;
}

/** Value of an option `-x v`, `--long v` or `--long=v` (first match). @param {Word[]} args @param {string[]} names */
export function optionValue(args, names) {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    for (const nm of names) {
      // Single-letter options are case-sensitive (tar -C vs -c); long / PowerShell options are not.
      if (nm.length === 2 ? v === nm : v.toLowerCase() === nm.toLowerCase()) return args[k + 1] ?? null;
      if (nm.startsWith('-') && v.toLowerCase().startsWith(`${nm.toLowerCase()}=`)) return { ...args[k], v: v.slice(nm.length + 1), raw: args[k].raw.slice(nm.length + 1) };
      if (nm.startsWith('-') && !nm.startsWith('--') && nm.length > 2 && v.toLowerCase().startsWith(`${nm.toLowerCase()}:`)) return { ...args[k], v: v.slice(nm.length + 1), raw: args[k].raw.slice(nm.length + 1) };
    }
  }
  return null;
}
