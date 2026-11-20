/** Design-space resolution and palette. Gameplay is laid out in design space and fitted with computeLayout(). */
export const GAME_CONFIG = {
  designWidth: 720,
  designHeight: 1280,
  background: '#121624',
  colors: {
    text: '#e8ecf8',
    accent: 0x5b8cff,
    accentHover: 0x7aa2ff,
    panel: 0x1d2338,
  },
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
} as const;
