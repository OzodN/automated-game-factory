// @ts-check
/**
 * `assets stats` (FX-13): library totals, then one line per source and one line per pack with the verified / declared
 * split (effective verification from PACK.json, see loadCatalog in assets.mjs), licenses and authors.
 */

/** @param {any[]} items catalog entries with their effective `verification` @param {(e: any) => string} key */
function groupBy(items, key) {
  /** @type {Map<string, { files: number, verified: number, packs: Set<string>, license: Set<string>, author: Set<string> }>} */
  const m = new Map();
  for (const e of items) {
    const k = key(e);
    const g = m.get(k) || { files: 0, verified: 0, packs: new Set(), license: new Set(), author: new Set() };
    g.files++;
    if (e.verification === 'verified') g.verified++;
    g.packs.add(e.pack);
    g.license.add(e.license);
    if (e.author) g.author.add(e.author);
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** @param {{ files: number, verified: number }} g */
const split = (g) => `${g.files} file(s), ${g.verified} verified, ${g.files - g.verified} declared`;

/** @param {string} root library root @param {any[]} items */
export function statsText(root, items) {
  /** @param {string} k */
  const by = (k) => items.reduce((a, e) => ({ ...a, [e[k]]: (a[e[k]] || 0) + 1 }), {});
  const perSource = groupBy(items, (e) => String(e.pack).split('/')[0]).map(([k, g]) => `  ${k}\t${g.packs.size} pack(s), ${split(g)}`);
  const perPack = groupBy(items, (e) => String(e.pack))
    .map(([k, g]) => `  ${k}\t${split(g)}\t${[...g.license].join(',')}\t${[...g.author].join(', ') || '-'}`);
  return [
    `library ${root}`, `assets: ${items.length}`, `by type: ${JSON.stringify(by('type'))}`, `by license: ${JSON.stringify(by('license'))}`,
    `by verification: ${JSON.stringify(by('verification'))}`, `packs: ${new Set(items.map((e) => e.pack)).size}`,
    'by source (packs, files: verified / declared):', ...perSource,
    'by pack (files: verified / declared, license, author):', ...perPack,
  ].join('\n');
}
