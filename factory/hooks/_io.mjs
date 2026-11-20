// @ts-check
/** Shared hook I/O: read JSON from stdin, emit JSON on stdout. Hooks never crash the session. */
export async function readInput() {
  let d = '';
  for await (const c of process.stdin) d += c;
  try { return JSON.parse(d || '{}'); } catch { return {}; }
}

export function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}
