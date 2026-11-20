// @ts-check
/**
 * Asset license policy (factory/standards/assets.md, AS-02). Shared by the library CLI (`assets.mjs`, which
 * re-exports it) and the remote index sync, so both apply exactly the same rules.
 */

/** License policy. SPDX ids. */
export const LICENSES = {
  'CC0-1.0': { ok: true, attribution: false },
  'Unlicense': { ok: true, attribution: false },
  'OFL-1.1': { ok: true, attribution: false, note: 'fonts: keep license file; self-host only' },
  'MIT': { ok: true, attribution: true },
  'Apache-2.0': { ok: true, attribution: true },
  'CC-BY-3.0': { ok: true, attribution: true },
  'CC-BY-4.0': { ok: true, attribution: true },
};
export const REJECT_RE = /(SA|NC|ND)|GPL|proprietary|personal|unknown/i;
/** Licenses that need no attribution (`--license cc0`). */
export const CC0_LIKE = ['CC0-1.0', 'Unlicense'];

/** True when the SPDX id is allowed by factory policy. @param {unknown} spdx */
export function licenseAllowed(spdx) {
  return typeof spdx === 'string' && Object.prototype.hasOwnProperty.call(LICENSES, spdx) && !REJECT_RE.test(spdx);
}

/** Asset type by file extension (library ingest and remote items without an explicit type). */
export const TYPE_BY_EXT = {
  png: 'sprite', jpg: 'sprite', jpeg: 'sprite', webp: 'sprite', gif: 'sprite', svg: 'vector',
  ogg: 'audio', mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  glb: 'model', gltf: 'model', obj: 'model', mtl: 'model', bin: 'model', fbx: 'model',
  json: 'data', xml: 'data', tmx: 'data', tsx: 'data', atlas: 'data', fnt: 'data',
  txt: 'doc', md: 'doc', pdf: 'doc',
};
