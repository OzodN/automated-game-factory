// @ts-check
/**
 * Human conversation language (FX-18). Artifacts, code, CLI args, subagent prompts and commits stay English;
 * only the human <-> orchestrator conversation follows this setting.
 *
 * Sources, first match wins: env FACTORY_HUMAN_LANGUAGE, factory/config.json "humanLanguage", default "auto".
 * "auto" = reply in the language the human writes in; any other non-empty string (BCP-47 code such as "ru",
 * "en", "es", or a language name) = always use it.
 */
import { loadConfig } from './core.mjs';

export const HUMAN_LANGUAGE_ENV = 'FACTORY_HUMAN_LANGUAGE';
export const HUMAN_LANGUAGE_DEFAULT = 'auto';

/**
 * @typedef {{ value: string, source: 'env' | 'config' | 'default', warning: string }} HumanLanguage
 * @param {Record<string, any>} [cfg] parsed factory config (default: loadConfig())
 * @param {Record<string, string | undefined>} [env]
 * @returns {HumanLanguage}
 */
export function humanLanguage(cfg = loadConfig(), env = process.env) {
  let warning = '';
  const fromEnv = typeof env[HUMAN_LANGUAGE_ENV] === 'string' ? env[HUMAN_LANGUAGE_ENV].trim() : '';
  if (fromEnv) return { value: fromEnv, source: 'env', warning };
  const raw = cfg?.humanLanguage;
  if (typeof raw === 'string' && raw.trim()) return { value: raw.trim(), source: 'config', warning };
  if (raw !== undefined) {
    warning = `factory/config.json "humanLanguage" must be a non-empty string (got ${JSON.stringify(raw)}); using "${HUMAN_LANGUAGE_DEFAULT}"`;
  }
  return { value: HUMAN_LANGUAGE_DEFAULT, source: 'default', warning };
}

/** @param {string} value */
export function isAuto(value) {
  return value.toLowerCase() === HUMAN_LANGUAGE_DEFAULT;
}

/**
 * The one line the SessionStart hook injects, e.g. `Human language: auto (reply in the human's language)`.
 * @param {HumanLanguage} [lang]
 */
export function humanLanguageLine(lang = humanLanguage()) {
  return isAuto(lang.value) ? AUTO_LINE : `Human language: ${lang.value} (always reply in it; artifacts stay English)`;
}

export const AUTO_LINE = "Human language: auto (reply in the human's language; artifacts stay English)";

/**
 * Doctor row: informational, never a failure; an invalid config type is a warning.
 * @param {Record<string, any>} [cfg]
 * @param {Record<string, string | undefined>} [env]
 */
export function humanLanguageRow(cfg = loadConfig(), env = process.env) {
  const lang = humanLanguage(cfg, env);
  const src = lang.source === 'env' ? `env ${HUMAN_LANGUAGE_ENV}` : lang.source === 'config' ? 'factory/config.json' : 'default';
  return {
    ok: lang.warning ? 'warn' : true,
    item: 'Human language',
    detail: `${lang.value} (${src})`,
    action: lang.warning ? `${lang.warning}. Set "humanLanguage" to "auto" or a language code/name such as "en".` : '',
  };
}
