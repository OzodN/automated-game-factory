export type Dictionary = Record<string, string>;

/**
 * Localization per Playgama rules 3.4.1–3.4.3: English is default + fallback; the language comes
 * ONLY from Bridge `platform.language`; every declared language must translate every key.
 */
export class I18n {
  readonly language: string;

  constructor(private readonly dicts: Record<string, Dictionary>, platformLanguage: string) {
    if (!dicts.en) throw new Error('I18n: English ("en") dictionary is mandatory');
    const lang = (platformLanguage || 'en').toLowerCase().split(/[-_]/)[0] ?? 'en';
    this.language = dicts[lang] ? lang : 'en';
  }

  t(key: string, params: Record<string, string | number> = {}): string {
    const raw = this.dicts[this.language]?.[key] ?? this.dicts.en?.[key];
    if (raw === undefined) return key;
    return raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
  }

  get supported(): string[] {
    return Object.keys(this.dicts);
  }
}

/** Returns a list of problems; use in a unit test so incomplete translations fail CI. */
export function findMissingTranslations(dicts: Record<string, Dictionary>): string[] {
  const problems: string[] = [];
  const base = Object.keys(dicts.en ?? {});
  for (const [lang, d] of Object.entries(dicts)) {
    for (const k of base) if (!(k in d) || d[k] === '') problems.push(`${lang}: missing "${k}"`);
    for (const k of Object.keys(d)) if (!base.includes(k)) problems.push(`${lang}: extra key "${k}" not in en`);
    for (const k of base) {
      const want = new Set((dicts.en![k]!.match(/\{\w+\}/g) ?? []).sort());
      const got = new Set((d[k]?.match(/\{\w+\}/g) ?? []).sort());
      if ([...want].join() !== [...got].join()) problems.push(`${lang}: placeholders differ for "${k}"`);
    }
  }
  return problems;
}
