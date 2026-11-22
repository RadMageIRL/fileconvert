// Animated WebP writing. Each frame is encoded as a still WebP (by the browser's canvas encoder, or libwebp where the
// canvas has none), and its image chunks (VP8 or VP8L, with ALPH for lossy frames with transparency) are wrapped in
// ANMF frame chunks: full-canvas frames that replace the previous one (no blending, no disposal), so what each frame
// shows does not depend on how a viewer composites. ANIM carries the loop count; VP8X the canvas size and flags.

export interface WebpFrame {
  /** A complete still WebP file for this frame, at the canvas size. */
  webp: Uint8Array;
  /** Milliseconds, 1 to 16,777,215. */
  duration: number;
}

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** The ALPH, VP8 and VP8L chunks of a still WebP, with their headers and padding, ready to go inside ANMF. */
export function imageChunks(webp: Uint8Array): Uint8Array {
  if (tag(webp, 0) !== 'RIFF' || tag(webp, 8) !== 'WEBP') throw new Error('The frame encoder did not produce WebP.');
  const dv = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const parts: Uint8Array[] = [];
  for (let p = 12; p + 8 <= webp.length;) {
    const type = tag(webp, p);
    const len = dv.getUint32(p + 4, true);
    const size = 8 + len + (len & 1);
    if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L') parts.push(webp.subarray(p, Math.min(webp.length, p + size)));
    p += size;
  }
  if (!parts.some(c => tag(c, 0) !== 'ALPH')) throw new Error('The encoded frame has no image data.');
  return concat(parts);
}

const u24 = (out: Uint8Array, at: number, v: number) => { out[at] = v & 0xff; out[at + 1] = (v >> 8) & 0xff; out[at + 2] = (v >> 16) & 0xff; };

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length & 1));
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

/** Builds the animated WebP. `plays` is how many times it plays, 0 for forever. */
export function writeAnimatedWebp(frames: WebpFrame[], width: number, height: number, plays: number, alpha: boolean): Uint8Array {
  if (!frames.length) throw new Error('There are no frames to write.');
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (alpha ? 0x10 : 0);
  u24(vp8x, 4, width - 1);
  u24(vp8x, 7, height - 1);
  const anim = new Uint8Array(6); // background color transparent black, then the loop count
  new DataView(anim.buffer).setUint16(4, Math.min(0xffff, Math.max(0, plays)), true);
  const parts = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
  for (const f of frames) {
    const data = imageChunks(f.webp);
    const head = new Uint8Array(16);
    // X and Y offsets 0; width and height minus one; duration; flags: bit 1 set = do not blend, bit 0 clear = no disposal.
    u24(head, 6, width - 1);
    u24(head, 9, height - 1);
    u24(head, 12, Math.max(1, Math.min(0xffffff, Math.round(f.duration))));
    head[15] = 0x02;
    parts.push(chunk('ANMF', concat([head, data])));
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set(body, 12);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
