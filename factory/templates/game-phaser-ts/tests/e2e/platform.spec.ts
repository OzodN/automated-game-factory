import { test, expect, VIEWPORTS, canvasBox } from './fixtures';

/** Playgama platform contract, verified on the production build in a real browser. */
for (const vp of VIEWPORTS) {
  test(`boots to an interactive menu with game_ready and fills the ${vp.name} viewport`, async ({ page, h }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const t0 = Date.now();
    await h.open();
    expect(Date.now() - t0, 'first interactive screen within 5 s').toBeLessThan(5000);
    const box = await canvasBox(page);
    expect(box).not.toBeNull();
    expect(Math.abs(box!.width - vp.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.height - vp.height)).toBeLessThanOrEqual(1);
    expect(h.externalRequests, 'no external requests (1.2.5)').toEqual([]);
    expect(h.consoleErrors, 'no console errors').toEqual([]);
  });
}

test('audio and pause follow platform, ads and visibility (2.1.3, 3.3.4, 3.3.5)', async ({ h }) => {
  await h.open();
  expect(await h.hook('__PG_TEST__.audioAllowed()')).toBe(true);
  for (const patch of ['{platformAudioEnabled:false}', '{adOpen:true}', '{hidden:true}', '{platformPaused:true}']) {
    await h.hook(`__PG_TEST__.simulate(${patch})`);
    expect(await h.hook('__PG_TEST__.audioAllowed()'), patch).toBe(false);
    await h.hook('__PG_TEST__.simulate({platformAudioEnabled:true,adOpen:false,hidden:false,platformPaused:false})');
  }
  await h.hook('__PG_TEST__.simulate({platformPaused:true})');
  expect(await h.hook('__PG_TEST__.systemPaused()')).toBe(true);
});

test('keys never scroll the host page and Escape does nothing (1.5.1, 1.5.2)', async ({ page, h }) => {
  await h.open();
  const before = await h.hook<{ scenes: string[] }>('__PG_TEST__.state()');
  for (const key of ['Space', 'ArrowDown', 'PageDown', 'Escape']) await page.keyboard.press(key);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  expect((await h.hook<{ scenes: string[] }>('__PG_TEST__.state()')).scenes).toEqual(before.scenes);
});

/**
 * FD-06 lesson: asserting that keys do not scroll is not enough, a key must also REACH gameplay. Real keyboard events
 * (page.keyboard) go through the whole production listener chain; the probe in src/game/test-state.ts records what a
 * Phaser keyboard handler received. Copy this test for every key the game uses (see GAME_CONVENTIONS.md).
 */
test('real Space, ArrowLeft and ArrowRight reach a Phaser handler and are still default-prevented (1.5.1, FD-06)', async ({ page, h }) => {
  await h.open();
  // Observe the FINAL defaultPrevented of each keydown (after every listener of the dispatch has run).
  await page.evaluate(() => {
    const w = window as unknown as { __prevented: Record<string, boolean> };
    w.__prevented = {};
    window.addEventListener('keydown', (e) => {
      setTimeout(() => { w.__prevented[e.code] = e.defaultPrevented; }, 0);
    });
  });
  const keys = ['Space', 'ArrowLeft', 'ArrowRight'];
  for (const key of keys) await page.keyboard.press(key);
  await expect
    .poll(async () => (await h.hook<{ keysSeen: string[] }>('__PG_TEST__.state()')).keysSeen, { message: 'keys that reached Phaser' })
    .toEqual(expect.arrayContaining(keys));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prevented: Record<string, boolean> }).__prevented), { message: 'scroll keys are default-prevented' })
    .toEqual({ Space: true, ArrowLeft: true, ArrowRight: true });
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  // Same during gameplay: the Play scene must receive keys too.
  await h.hook('__PG_TEST__.actions.play()');
  await expect.poll(async () => (await h.hook<{ scenes: string[] }>('__PG_TEST__.state()')).scenes).toContain('Play');
  const before = (await h.hook<{ keysTotal: number }>('__PG_TEST__.state()')).keysTotal;
  await page.keyboard.press('Space');
  await expect.poll(async () => (await h.hook<{ keysTotal: number }>('__PG_TEST__.state()')).keysTotal).toBe(before + 1);
  expect(h.consoleErrors).toEqual([]);
});

/** Phaser 4.2.1 replays queued key events (D-03): one physical Enter must start Play exactly once (key-dedupe helper). */
test('one real Enter on the Menu starts Play exactly once (D-03, FD-06)', async ({ page, h }) => {
  await h.open();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await h.hook<{ scenes: string[] }>('__PG_TEST__.state()')).scenes).toContain('Play');
  // The replay of a queued event arrives on a later frame: let a few frames pass before counting.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
  const s = await h.hook<{ keysTotal: number; sceneStarts: Record<string, number> }>('__PG_TEST__.state()');
  expect(s.keysTotal, 'one physical press is one distinct key event').toBe(1);
  expect(s.sceneStarts.Play, 'Play was created exactly once').toBe(1);
  expect(h.consoleErrors).toEqual([]);
});

test('progress survives a reload (3.2.3)', async ({ page, h }) => {
  await h.open();
  await h.hook('__PG_TEST__.actions.play()');
  await expect.poll(async () => (await h.hook<{ scenes: string[] }>('__PG_TEST__.state()')).scenes).toContain('Play');
  await h.hook('__PG_TEST__.actions.finish()');
  await expect.poll(async () => (await h.hook<{ save: { plays: number } }>('__PG_TEST__.state()')).save.plays).toBe(1);
  // Wait for the write to land in Bridge storage (localStorage fallback in the test harness), not for a fixed delay.
  await expect
    .poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.includes('_save') && /"plays":\s*1/.test(localStorage.getItem(k) ?? ''))), {
      message: 'save persisted to storage',
    })
    .toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.__PG_TEST__?.gameReadySent()))).toBe(true);
  expect((await h.hook<{ save: { plays: number } }>('__PG_TEST__.state()')).save.plays).toBe(1);
  expect(h.consoleErrors).toEqual([]);
});
