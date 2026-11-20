// Lint rules double as machine-checked Playgama requirements (see factory/standards/playgama-compliance.md).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const PLAYGAMA = 'Playgama requirement';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-globals': ['error',
        { name: 'localStorage', message: `${PLAYGAMA} 3.2.1: save through Bridge storage (SaveStore) only.` },
        { name: 'sessionStorage', message: `${PLAYGAMA} 3.2.1: save through Bridge storage only.` },
        { name: 'indexedDB', message: `${PLAYGAMA} 3.2.1: save through Bridge storage only.` },
        { name: 'fetch', message: `${PLAYGAMA} 1.2.5: no network requests; load bundled assets through the Phaser loader.` },
        { name: 'XMLHttpRequest', message: `${PLAYGAMA} 1.2.5: no network requests.` },
        { name: 'WebSocket', message: `${PLAYGAMA} 1.2.5: no network requests.` },
        { name: 'AudioContext', message: `${PLAYGAMA} 3.3.2: no code-synthesized sound; play ogg/mp3 files through Phaser sound.` },
        { name: 'OscillatorNode', message: `${PLAYGAMA} 3.3.2: no code-synthesized sound.` },
      ],
      'no-restricted-properties': ['error',
        { object: 'document', property: 'cookie', message: `${PLAYGAMA} 3.2.1: no cookies.` },
        { object: 'window', property: 'localStorage', message: `${PLAYGAMA} 3.2.1` },
        { object: 'window', property: 'open', message: `${PLAYGAMA} 1.2.6: links out only via a guarded helper when platform.isExternalLinksAllowed.` },
        { object: 'navigator', property: 'language', message: `${PLAYGAMA} 3.4.2: language comes only from Bridge platform.language.` },
        { object: 'navigator', property: 'languages', message: `${PLAYGAMA} 3.4.2: language comes only from Bridge platform.language.` },
        { object: 'Math', property: 'random', message: 'Factory standard GE-RNG: use ctx.rng (seeded) so tests are deterministic.' },
        { property: 'createOscillator', message: `${PLAYGAMA} 3.3.2: no code-synthesized sound.` },
      ],
      'no-restricted-syntax': ['error',
        { selector: "Literal[value='Escape']", message: `${PLAYGAMA} 1.5.2: the Escape key must not be used by the game.` },
        { selector: "Literal[value='ESC']", message: `${PLAYGAMA} 1.5.2: the Escape key must not be used by the game.` },
        { selector: "MemberExpression[object.name='KeyCodes'][property.name='ESC']", message: `${PLAYGAMA} 1.5.2: the Escape key must not be used.` },
        { selector: "Literal[value=/https?:\\/\\//]", message: `${PLAYGAMA} 1.2.5: no external URLs in game code.` },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  },
);
