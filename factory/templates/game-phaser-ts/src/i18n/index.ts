import type { Dictionary } from '@factory/pg-kit';

/** English is mandatory (default + fallback). Every declared language must contain every key (unit-tested). */
export const DICTIONARIES: Record<string, Dictionary> = {
  en: {
    title: '__GAME_TITLE__',
    play: 'Play',
    tap_hint: 'Tap the target {n} times',
    score: 'Score: {n}',
    best: 'Best: {n}',
    game_over: 'Game Over',
    menu: 'Menu',
    retry: 'Play again',
    double_reward: 'Double score',
  },
  ru: {
    title: '__GAME_TITLE__',
    play: 'Играть',
    tap_hint: 'Нажмите на цель {n} раз',
    score: 'Очки: {n}',
    best: 'Рекорд: {n}',
    game_over: 'Игра окончена',
    menu: 'Меню',
    retry: 'Ещё раз',
    double_reward: 'Удвоить очки',
  },
};
