// Resampling for Resize images (and the size option of Compress JPEG): Lanczos-3, the filter Pillow and most image
// editors use for quality reductions, separable, its window widened by the reduction so every source pixel counts
// (Pillow's method). Colors are weighted by alpha (premultiplied) so transparent edges do not darken, 16-bit pictures
// stay 16-bit, and the picture is never held twice: rows are scaled across one at a time as the rows below need them,
// into a ring of as many rows as the filter spans, then down. Also the EXIF orientation, applied to the pixels.

export type Pixels = Uint8ClampedArray | Uint16Array;
export interface Picture { data: Pixels; width: number; height: number }

const lanczos = (x: number) => {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const p = Math.PI * x;
  return (3 * Math.sin(p) * Math.sin(p / 3)) / (p * p);
};

/** For each output position, its first source position and normalized weights (Pillow's precompute_coeffs). */
function weights(inSize: number, outSize: number): { first: Int32Array; count: Int32Array; w: Float32Array; taps: number } {
  const scale = inSize / outSize;
  const fscale = Math.max(scale, 1);
  const support = 3 * fscale;
  const taps = Math.ceil(support) * 2 + 1;
  const first = new Int32Array(outSize), count = new Int32Array(outSize);
  const w = new Float32Array(outSize * taps);
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    const lo = Math.max(0, Math.floor(center - support + 0.5));
    const hi = Math.min(inSize, Math.floor(center + support + 0.5));
    let sum = 0;
    const n = hi - lo;
    for (let i = 0; i < n; i++) {
      const v = lanczos((i + lo - center + 0.5) / fscale);
      w[o * taps + i] = v;
      sum += v;
    }
    if (sum) for (let i = 0; i < n; i++) w[o * taps + i] /= sum;
    first[o] = lo;
    count[o] = n;
  }
  return { first, count, w, taps };
}

/** The picture at a new size. Gray, opaque and transparent pictures alike; the result is the same kind of array. */
export function resample(src: Picture, width: number, height: number): Picture {
  const W = src.width, H = src.height, d = src.data;
  const wide = d instanceof Uint16Array;
  const max = wide ? 65535 : 255;
  if (width === W && height === H) return { data: d.slice() as Pixels, width, height };
  const hx = weights(W, width), hy = weights(H, height);
  // Ring of rows scaled across: as many as the vertical filter spans.
  const ringRows = hy.taps + 1;
  const ring = new Float32Array(ringRows * width * 4);
  const ringOf = new Int32Array(ringRows).fill(-1);
  const across = (y: number) => {
    const slot = y % ringRows;
    if (ringOf[slot] === y) return slot;
    const base = slot * width * 4;
    const row = y * W * 4;
    for (let x = 0; x < width; x++) {
      const f = hx.first[x], n = hx.count[x], wo = x * hx.taps;
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < n; i++) {
        const k = hx.w[wo + i];
        const p = row + (f + i) * 4;
        const al = d[p + 3];
        const ka = k * al;
        r += d[p] * ka; g += d[p + 1] * ka; b += d[p + 2] * ka; a += ka;
      }
      const o = base + x * 4;
      ring[o] = r; ring[o + 1] = g; ring[o + 2] = b; ring[o + 3] = a;
    }
    ringOf[slot] = y;
    return slot;
  };
  const out = wide ? new Uint16Array(width * height * 4) : new Uint8ClampedArray(width * height * 4);
  const slots = new Int32Array(hy.taps);
  for (let y = 0; y < height; y++) {
    const f = hy.first[y], n = hy.count[y], wo = y * hy.taps;
    for (let i = 0; i < n; i++) slots[i] = across(f + i) * width * 4;
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const c = x * 4;
      for (let i = 0; i < n; i++) {
        const k = hy.w[wo + i];
        const p = slots[i] + c;
        r += ring[p] * k; g += ring[p + 1] * k; b += ring[p + 2] * k; a += ring[p + 3] * k;
      }
      // a is alpha times the color scale (each color was weighted by its alpha); undo it.
      const q = o + c;
      if (a <= 0) { out[q] = out[q + 1] = out[q + 2] = out[q + 3] = 0; continue; }
      const alpha = Math.min(max, Math.max(0, Math.round(a)));
      const inv = 1 / a;
      out[q] = Math.min(max, Math.max(0, Math.round(r * inv)));
      out[q + 1] = Math.min(max, Math.max(0, Math.round(g * inv)));
      out[q + 2] = Math.min(max, Math.max(0, Math.round(b * inv)));
      out[q + 3] = alpha;
    }
  }
  return { data: out, width, height };
}

/** The pixels turned upright from an EXIF orientation (2 to 8; 1 is as stored). */
export function orient(src: Picture, orientation: number): Picture {
  if (orientation < 2 || orientation > 8) return src;
  const { width: W, height: H, data: d } = src;
  const swap = orientation >= 5;
  const w = swap ? H : W, h = swap ? W : H;
  const out = d instanceof Uint16Array ? new Uint16Array(d.length) : new Uint8ClampedArray(d.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let nx: number, ny: number;
      switch (orientation) {
        case 2: nx = W - 1 - x; ny = y; break;
        case 3: nx = W - 1 - x; ny = H - 1 - y; break;
        case 4: nx = x; ny = H - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = H - 1 - y; ny = x; break;
        case 7: nx = H - 1 - y; ny = W - 1 - x; break;
        default: nx = y; ny = W - 1 - x; break; // 8
      }
      const s = (y * W + x) * 4, t = (ny * w + nx) * 4;
      out[t] = d[s]; out[t + 1] = d[s + 1]; out[t + 2] = d[s + 2]; out[t + 3] = d[s + 3];
    }
  }
  return { data: out, width: w, height: h };
}
