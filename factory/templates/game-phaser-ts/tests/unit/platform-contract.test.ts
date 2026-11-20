import { describe, it, expect } from 'vitest';
import { findMissingTranslations, SaveStore } from '@factory/pg-kit';
import { createBridgeMock } from '@factory/pg-kit/testing';
import { DICTIONARIES } from '../../src/i18n';
import { SAVE_SCHEMA } from '../../src/game/save';

describe('localization (rules 3.4.1, 3.4.3)', () => {
  it('has English and every key translated in every language', () => {
    expect(DICTIONARIES.en).toBeDefined();
    expect(findMissingTranslations(DICTIONARIES)).toEqual([]);
  });
});

describe('save schema (rules 3.2.1-3.2.3)', () => {
  it('round-trips through Bridge storage and repairs corrupt data', async () => {
    const bridge = createBridgeMock();
    const a = new SaveStore(bridge, SAVE_SCHEMA);
    await a.load();
    a.update((d) => ({ ...d, best: 30, plays: 2, userMuted: true }));
    await a.flush();
    expect(await new SaveStore(bridge, SAVE_SCHEMA).load()).toEqual({ best: 30, plays: 2, userMuted: true });
    const corrupt = createBridgeMock({ storage: { [SAVE_SCHEMA.key]: JSON.stringify({ v: 1, data: { best: 'x', plays: -3 } }) } });
    expect(await new SaveStore(corrupt, SAVE_SCHEMA).load()).toEqual(SAVE_SCHEMA.defaults());
  });
});
