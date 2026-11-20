export type Orientation = 'portrait' | 'landscape' | 'square';

export interface Layout {
  width: number;
  height: number;
  orientation: Orientation;
  /** Uniform scale that fits a design-space rectangle inside the viewport (letterbox-free: fill the rest with background art). */
  fitScale: number;
  /** Uniform scale that covers the viewport (for backgrounds). */
  coverScale: number;
  /** Design-space rectangle centered in the viewport after fitting. */
  content: { x: number; y: number; width: number; height: number };
}

/** The three reference viewports every game must support without black bars (rules 1.6.x). */
export const REFERENCE_VIEWPORTS = [
  { name: 'portrait-9x16', width: 375, height: 812 },
  { name: 'square-1x1', width: 600, height: 600 },
  { name: 'landscape-16x9', width: 1920, height: 1080 },
] as const;

/**
 * Responsive layout math for RESIZE-mode games: the canvas always fills the viewport; gameplay
 * content keeps its aspect via fitScale; backgrounds use coverScale so no bars ever appear.
 */
export function computeLayout(viewW: number, viewH: number, designW: number, designH: number): Layout {
  const w = Math.max(1, viewW);
  const h = Math.max(1, viewH);
  const ratio = w / h;
  const orientation: Orientation = ratio > 1.1 ? 'landscape' : ratio < 0.9 ? 'portrait' : 'square';
  const fitScale = Math.min(w / designW, h / designH);
  const coverScale = Math.max(w / designW, h / designH);
  const cw = designW * fitScale;
  const ch = designH * fitScale;
  return { width: w, height: h, orientation, fitScale, coverScale, content: { x: (w - cw) / 2, y: (h - ch) / 2, width: cw, height: ch } };
}
