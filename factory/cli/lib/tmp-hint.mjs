// @ts-check
/**
 * FX-16: a non-blocking hint for Bash lines that would put temp files at the drive root. With MSYS_NO_PATHCONV=1
 * Git Bash passes `/tmp/x` unconverted to native programs, which resolve it to `<drive>:\tmp\x`. Two precise cases:
 * a `mktemp` without a directory (it returns `/tmp/...`), and a `/tmp` or `$TMPDIR` argument of node/git/pnpm/npm.
 * Never used to deny. FX-20: on macOS/Linux there is no drive-root hazard, but /tmp, $TMPDIR and a bare mktemp still
 * put scratch files outside the factory (untracked, not cleaned by the factory), so a platform-neutral hint is given.
 */

const NATIVE = new Set(['node', 'node.exe', 'git', 'git.exe', 'pnpm', 'pnpm.cmd', 'corepack', 'corepack.cmd', 'npm', 'npm.cmd', 'npx', 'npx.cmd']);
const POSIX_TMP_RE = /(^|[\s'"=])(\/tmp(?=[\/\s'"]|$)|\$\{?TMPDIR\}?)/;
const MKTEMP_RE = /(?:^|[\s;&|(`])mktemp(?=[\s;&|)`]|$)([^;&|)`\n]*)/g;

export const TMP_HINT = 'Hint (FX-16, not a refusal): with MSYS_NO_PATHCONV=1 node/git/pnpm resolve /tmp/... to <drive>:\\tmp\\... at the drive root. '
  + 'Use the factory scratch dir instead, e.g. mktemp -d -p "<factory root>/.cache/tmp", and pass D:/... paths (or $(cygpath -m <path>)) to native programs.';

export const TMP_HINT_POSIX = 'Hint (FX-16, not a refusal): keep scratch files inside the factory, not in /tmp or $TMPDIR. '
  + 'Use the factory scratch dir, e.g. mktemp -d -p "<factory root>/.cache/tmp", and remove what you create.';

/** The hint text for a platform: the MSYS-specific wording on Windows only. @param {string} platform */
export function tmpHintFor(platform) {
  return platform === 'win32' ? TMP_HINT : TMP_HINT_POSIX;
}

/** A directory argument is acceptable unless it is a POSIX /tmp-like path or $TMPDIR. @param {string} v */
function goodDir(v) {
  const s = v.replace(/^['"]|['"]$/g, '');
  if (!s) return false;
  if (/^\$\{?(TMPDIR|TMP|TEMP)\}?/.test(s)) return false;
  return !s.startsWith('/');
}

/** True when the `mktemp` arguments name no acceptable directory. @param {string} args */
function bareMktemp(args) {
  const toks = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-p' || t === '--tmpdir') return !goodDir(toks[i + 1] || '');
    if (t.startsWith('--tmpdir=')) return !goodDir(t.slice(9));
    if (/^-[A-Za-z]*p$/.test(t) && t !== '-p') return !goodDir(toks[i + 1] || '');
    if (!t.startsWith('-') && /[\\/]/.test(t)) return !goodDir(t);
  }
  return true;
}

/**
 * The hint text when the command line matches one of the precise cases, else null.
 * @param {string} cmd
 * @param {string} [platform] defaults to process.platform
 */
export function scratchPathHint(cmd, platform = process.platform) {
  const hint = tmpHintFor(platform);
  const text = String(cmd || '');
  for (const m of text.matchAll(MKTEMP_RE)) if (bareMktemp(m[1])) return hint;
  for (const seg of text.split(/&&|\|\||[;|\n]|\$\(/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const head = (words[0] || '').replace(/^.*[\\/]/, '').toLowerCase();
    if (NATIVE.has(head) && POSIX_TMP_RE.test(words.slice(1).join(' '))) return hint;
  }
  return null;
}
