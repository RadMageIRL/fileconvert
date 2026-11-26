// SSIM, the structural similarity index (Wang, Bovik, Sheikh and Simoncelli, 2004), offered as an optional measure of how
// close a lossy result is to its original: 1 means the same. It is computed on brightness (luma, BT.601 weights, colors
// over white where transparent) at full resolution, with an 11 x 11 Gaussian window (sigma 1.5) and the paper's constants,
// over the positions where the whole window fits in the picture, as scikit-image computes it (gaussian_weights, no sample
// covariance). Rows are filtered across as they are read and kept in rings of 11, so the picture is never copied.
// SSIM is one measure of change; it is not a full measure of what people notice.

const RADIUS = 5;
const WIN = 2 * RADIUS + 1;

const kernel = (() => {
  const k = new Float64Array(WIN);
  let s = 0;
  for (let i = 0; i < WIN; i++) { k[i] = Math.exp(-((i - RADIUS) ** 2) / (2 * 1.5 * 1.5)); s += k[i]; }
  for (let i = 0; i < WIN; i++) k[i] /= s;
  return k;
})();

type Rgba = Uint8ClampedArray | Uint8Array | Uint16Array;

/** The luma of one row, 0 to 255, colors over white where transparent. */
function lumaRow(d: Rgba, width: number, y: number, out: Float64Array): void {
  const max = d instanceof Uint16Array ? 65535 : 255;
  const s = 255 / max;
  for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
    const a = d[i + 3] / max;
    const r = d[i] * s * a + 255 * (1 - a), g = d[i + 1] * s * a + 255 * (1 - a), b = d[i + 2] * s * a + 255 * (1 - a);
    out[x] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
}

/** SSIM between two pictures of the same size, or null when the picture is smaller than the window. */
export function ssim(a: Rgba, b: Rgba, width: number, height: number): number | null {
  if (width < WIN || height < WIN) return null;
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const vw = width - 2 * RADIUS;
  // Per row, filtered across (valid positions only): x, y, x squared, y squared, x times y.
  const rings = Array.from({ length: 5 }, () => new Float64Array(WIN * vw));
  const la = new Float64Array(width), lb = new Float64Array(width);
  let total = 0, count = 0;
  for (let y = 0; y < height; y++) {
    lumaRow(a, width, y, la);
    lumaRow(b, width, y, lb);
    const slot = (y % WIN) * vw;
    for (let x = 0; x < vw; x++) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < WIN; k++) {
        const w = kernel[k], p = la[x + k], q = lb[x + k];
        sx += w * p; sy += w * q; sxx += w * p * p; syy += w * q * q; sxy += w * p * q;
      }
      rings[0][slot + x] = sx; rings[1][slot + x] = sy; rings[2][slot + x] = sxx; rings[3][slot + x] = syy; rings[4][slot + x] = sxy;
    }
    if (y < WIN - 1) continue;
    // The window's rows are y - 10 to y; row y - 10 + k sits in slot (y - 10 + k) % 11.
    for (let x = 0; x < vw; x++) {
      let mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0;
      for (let k = 0; k < WIN; k++) {
        const s = ((y - 2 * RADIUS + k) % WIN) * vw + x, w = kernel[k];
        mx += w * rings[0][s]; my += w * rings[1][s]; mxx += w * rings[2][s]; myy += w * rings[3][s]; mxy += w * rings[4][s];
      }
      const vx = mxx - mx * mx, vy = myy - my * my, cxy = mxy - mx * my;
      total += ((2 * mx * my + C1) * (2 * cxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      count++;
    }
  }
  return total / count;
}
