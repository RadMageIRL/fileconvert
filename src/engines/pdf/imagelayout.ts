// Where each picture goes on its page, for Images to PDF. Nothing here touches pixels: a picture is always embedded
// with every pixel it has, and placed on the page by a transformation matrix, so fitting, centering and turning it
// upright (its EXIF orientation) never resample it. A picture's own size comes from its resolution (pixels per inch,
// when the file gives one; 96 otherwise). By default it is never enlarged beyond that size and never cut off.

export interface ImagePageOptions {
  /** A4, US Letter, or a page the size of each picture. */
  size: 'a4' | 'letter' | 'picture';
  /** For A4 and Letter: each page as its picture (landscape for a wide one), or all one way. */
  orientation: 'auto' | 'portrait' | 'landscape';
  /** Space around each picture, in millimetres. */
  margin: number;
  /** For A4 and Letter: the whole picture inside the margins, or the space filled with its edges cut off. */
  fit: 'fit' | 'fill';
  /** For A4 and Letter: pictures smaller than the space are enlarged to fit it, not left at their own size. */
  enlarge: boolean;
}

/** Page sizes in points (1/72 inch). */
export const PAGE_SIZES = { a4: [595.2756, 841.8898], letter: [612, 792] } as const;
/** The largest page side PDF readers are expected to show (200 inches, Acrobat's limit), in points. */
export const MAX_PAGE_SIDE = 14_400;
/** The smallest page side most PDF readers accept, in points. */
export const MIN_PAGE_SIDE = 3;
/** The margin's limit, in millimetres. */
export const MAX_MARGIN = 50;
/** Pixels per inch assumed when a picture does not say. */
export const DEFAULT_DPI = 96;

const MM = 72 / 25.4;

export interface Placement {
  /** Page width and height, in points. */
  page: [number, number];
  /** Where the upright picture is drawn: x, y (lower left), width, height, in points. It may run past the page when
   *  filling, and is then cut to `clip`. */
  box: [number, number, number, number];
  clip: [number, number, number, number] | null;
  /** The drawn size against the picture's own size: below 1 when made smaller, above 1 when enlarged. */
  scale: number;
  /** The part of the picture's area cut off when filling, from 0 to 1. */
  crop: number;
  /** A page the size of the picture would have passed 200 inches, so the picture was drawn smaller. */
  capped: boolean;
  /** The resolution used for the picture's own size, and whether it was assumed. */
  dpi: [number, number];
  assumed: boolean;
}

/**
 * The page for one picture of `w` x `h` pixels as shown (after its orientation), at `dpi` across and down as shown, or
 * the default resolution when the file gives none.
 */
export function placePicture(w: number, h: number, dpi: [number, number] | null, o: ImagePageOptions): Placement {
  const res: [number, number] = dpi ?? [DEFAULT_DPI, DEFAULT_DPI];
  const nw = (w * 72) / res[0], nh = (h * 72) / res[1];
  const m = Math.max(0, Math.min(MAX_MARGIN, Number.isFinite(o.margin) ? o.margin : 0)) * MM;
  if (o.size === 'picture') {
    // The page is the picture with its margin; past 200 inches, the picture is drawn smaller to fit.
    const room = MAX_PAGE_SIDE - 2 * m;
    const s = Math.min(1, room / nw, room / nh);
    const dw = nw * s, dh = nh * s;
    const pw = Math.max(MIN_PAGE_SIDE, dw + 2 * m), ph = Math.max(MIN_PAGE_SIDE, dh + 2 * m);
    return { page: [pw, ph], box: [(pw - dw) / 2, (ph - dh) / 2, dw, dh], clip: null, scale: s, crop: 0, capped: s < 1, dpi: res, assumed: !dpi };
  }
  const [a, b] = PAGE_SIZES[o.size];
  const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && w > h);
  const pw = landscape ? b : a, ph = landscape ? a : b;
  const bw = pw - 2 * m, bh = ph - 2 * m;
  if (o.fit === 'fill') {
    const s = Math.max(bw / nw, bh / nh);
    const dw = nw * s, dh = nh * s;
    const crop = Math.max(0, 1 - (bw * bh) / (dw * dh));
    return { page: [pw, ph], box: [m + (bw - dw) / 2, m + (bh - dh) / 2, dw, dh], clip: crop > 1e-9 ? [m, m, bw, bh] : null, scale: s, crop: crop > 1e-9 ? crop : 0, capped: false, dpi: res, assumed: !dpi };
  }
  let s = Math.min(bw / nw, bh / nh);
  if (!o.enlarge) s = Math.min(s, 1);
  const dw = nw * s, dh = nh * s;
  return { page: [pw, ph], box: [m + (bw - dw) / 2, m + (bh - dh) / 2, dw, dh], clip: null, scale: s, crop: 0, capped: false, dpi: res, assumed: !dpi };
}

/**
 * The matrix (a b c d e f, as for the cm operator) that draws a picture stored with EXIF orientation `orientation`
 * upright into the box x, y, w, h (the box of the picture as shown). A PDF image fills the unit square with its first
 * row at the top; each orientation says where the stored rows and columns go when shown. For orientation 6 (turn a
 * quarter clockwise to show), the stored left column becomes the top row, and so on.
 */
export function orientationMatrix(orientation: number, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  // Shown position (X across from the left, Y down from the top, both 0 to 1) of the stored point (u across, t down).
  // As X = ax*u + bx*t + cx and Y = ay*u + by*t + cy.
  const maps: Record<number, [number, number, number, number, number, number]> = {
    1: [1, 0, 0, 0, 1, 0],
    2: [-1, 0, 1, 0, 1, 0],
    3: [-1, 0, 1, 0, -1, 1],
    4: [1, 0, 0, 0, -1, 1],
    5: [0, 1, 0, 1, 0, 0],
    6: [0, -1, 1, 1, 0, 0],
    7: [0, -1, 1, -1, 0, 1],
    8: [0, 1, 0, -1, 0, 1],
  };
  const [ax, bx, cx, ay, by, cy] = maps[orientation] ?? maps[1];
  // PDF image space: u across, v up, with t = 1 - v. Page: px = x + w*X, py = y + h*(1 - Y).
  // X = ax*u + bx*(1 - v) + cx;  Y = ay*u + by*(1 - v) + cy.
  const a = w * ax, c = -w * bx, e = x + w * (bx + cx);
  const b = -h * ay, d = h * by, f = y + h * (1 - by - cy);
  return [a, b, c, d, e, f];
}
