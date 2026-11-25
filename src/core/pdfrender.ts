// What drawing PDF pages as pictures makes, worked out before anything is drawn: the pixel size of each page at a
// resolution, and the limits on one picture. A page's size is the size it is shown at: its crop box (inside its media
// box), turned by its rotation and scaled by its UserUnit, as pdf.js draws it. Shared by the page, which checks a
// tool's choices before it runs, and the render worker, which checks again with the size pdf.js reports.

/** Why this browser cannot draw PDF pages: they are drawn in a worker, on an OffscreenCanvas. */
export const NO_CANVAS = 'This browser cannot draw PDF pages in the background: it has no OffscreenCanvas in workers. Current Chrome, Edge, Firefox and Safari (16.4 and later) have it.';

/** A page as it is shown, in points (1/72 inch). */
export interface PageSize {
  w: number;
  h: number;
}

/** What one picture of a page may be in this browser. */
export interface PictureLimits {
  /** The longest side, in pixels. */
  side: number;
  /** Pixels in one picture. */
  pixels: number;
}

export const RENDER = {
  dpiMin: 10,
  dpiMax: 1200,
  /** The resolutions offered as choices. */
  presets: [72, 150, 300] as const,
  /** The longest side of a canvas every current browser draws (and far less than JPEG's 65,535). */
  side: 32_767,
  /** Pixels in one picture: the same 100 megapixels FileConvert reads in any image, so its results can be opened again. */
  pixels: 100_000_000,
  /** On a phone or tablet whose browser does not report its memory (Safari on iOS and iPadOS): the largest canvas Safari
   *  draws there, 4,096 x 4,096. A larger one comes out blank instead of failing. */
  phonePixels: 16_777_216,
} as const;

/** The limits for this device: basis 'phone' is a phone or tablet whose browser does not report its memory. */
export function pictureLimits(basis: 'device' | 'computer' | 'phone'): PictureLimits {
  return { side: RENDER.side, pixels: basis === 'phone' ? RENDER.phonePixels : RENDER.pixels };
}

/** The picture of a page at a resolution, in pixels (each side at least 1). */
export function pixelSize(size: PageSize, dpi: number): { width: number; height: number } {
  const k = dpi / 72;
  return { width: Math.max(1, Math.round(size.w * k)), height: Math.max(1, Math.round(size.h * k)) };
}

/** The highest whole resolution at which the page fits the limits, or 0 when even the lowest does not. */
export function maxDpi(size: PageSize, L: PictureLimits): number {
  let dpi = Math.floor(Math.min(72 * Math.sqrt(L.pixels / Math.max(1e-9, size.w * size.h)), 72 * L.side / Math.max(1e-9, size.w, size.h), RENDER.dpiMax));
  const fits = (d: number) => { const p = pixelSize(size, d); return p.width * p.height <= L.pixels && Math.max(p.width, p.height) <= L.side; };
  while (dpi >= RENDER.dpiMin && !fits(dpi)) dpi--;
  return dpi >= RENDER.dpiMin ? dpi : 0;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Why page `n` cannot be drawn at this resolution, or null. The message gives the size it would have and the
 *  resolution at which it fits; nothing is ever drawn smaller than asked to make it fit. */
export function pictureProblem(n: number, size: PageSize, dpi: number, L: PictureLimits): string | null {
  const { width, height } = pixelSize(size, dpi);
  const px = width * height;
  if (px <= L.pixels && Math.max(width, height) <= L.side) return null;
  const mp = `${(px / 1e6).toFixed(px >= 1e9 ? 0 : 1)} megapixels`;
  const what = px > L.pixels
    ? (L.pixels === RENDER.phonePixels ? `${mp}, more than the 4,096 x 4,096 pixels Safari draws on a phone or tablet` : `${mp}, more than the ${fmt(L.pixels / 1e6)} megapixels one picture may have`)
    : `wider or taller than the ${fmt(L.side)} pixels a browser can draw`;
  const best = maxDpi(size, L);
  const advice = best ? ` At ${fmt(best)} dpi or less it fits.` : ' It is too large to draw at any resolution FileConvert offers.';
  return `Page ${fmt(n)} at ${fmt(dpi)} dpi would be ${fmt(width)} x ${fmt(height)} pixels, ${what}.${advice}`;
}

/** The size pdf.js shows a page at, from its boxes, rotation and UserUnit, the way pdf.js reads them: the crop box
 *  clipped to the media box (the media box when they do not overlap), a media box of US Letter when it has none, a
 *  rotation that is not a quarter turn ignored. Boxes are [x1, y1, x2, y2] in either corner order. */
export function shownSize(media: number[] | null, crop: number[] | null, rotate: number, userUnit: number): PageSize {
  const norm = (b: number[] | null) => {
    if (!b || b.length !== 4 || !b.every(Number.isFinite)) return null;
    const r = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
    return r[2] - r[0] > 0 && r[3] - r[1] > 0 ? r : null;
  };
  const m = norm(media) ?? [0, 0, 612, 792];
  const c = norm(crop);
  let v = m;
  if (c) {
    const x = [Math.max(m[0], c[0]), Math.max(m[1], c[1]), Math.min(m[2], c[2]), Math.min(m[3], c[3])];
    if (x[2] - x[0] > 0 && x[3] - x[1] > 0) v = x;
  }
  const unit = Number.isFinite(userUnit) && userUnit > 0 ? userUnit : 1;
  const r = rotate % 90 === 0 ? ((rotate % 360) + 360) % 360 : 0;
  const w = (v[2] - v[0]) * unit, h = (v[3] - v[1]) * unit;
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}
