// The fonts embedded in generated PDFs: Noto Sans and Noto Sans Mono (SIL Open Font License), which cover
// Latin, Greek and Cyrillic. They load only when a PDF is made. cmapCoverage() reads a font's character map
// so a conversion can say which characters the font cannot show, instead of printing blank boxes silently.

import monoBold from '@expo-google-fonts/noto-sans-mono/700Bold/NotoSansMono_700Bold.ttf?url';
import monoRegular from '@expo-google-fonts/noto-sans-mono/400Regular/NotoSansMono_400Regular.ttf?url';
import sansBold from '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url';
import sansBoldItalic from '@expo-google-fonts/noto-sans/700Bold_Italic/NotoSans_700Bold_Italic.ttf?url';
import sansItalic from '@expo-google-fonts/noto-sans/400Regular_Italic/NotoSans_400Regular_Italic.ttf?url';
import sansRegular from '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url';

export const FONT_FILES = {
  'NotoSans-Regular.ttf': sansRegular,
  'NotoSans-Bold.ttf': sansBold,
  'NotoSans-Italic.ttf': sansItalic,
  'NotoSans-BoldItalic.ttf': sansBoldItalic,
  'NotoSansMono-Regular.ttf': monoRegular,
  'NotoSansMono-Bold.ttf': monoBold,
} as const;

export type FontFile = keyof typeof FONT_FILES;

export const FONT_FAMILIES = {
  NotoSans: { normal: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf', italics: 'NotoSans-Italic.ttf', bolditalics: 'NotoSans-BoldItalic.ttf' },
  NotoSansMono: { normal: 'NotoSansMono-Regular.ttf', bold: 'NotoSansMono-Bold.ttf', italics: 'NotoSansMono-Regular.ttf', bolditalics: 'NotoSansMono-Bold.ttf' },
} as const;

/** Every code point a TrueType font maps to a glyph (cmap formats 4 and 12). */
export function cmapCoverage(ttf: Uint8Array): (cp: number) => boolean {
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const numTables = dv.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (String.fromCharCode(ttf[rec], ttf[rec + 1], ttf[rec + 2], ttf[rec + 3]) === 'cmap') cmap = dv.getUint32(rec + 8);
  }
  if (cmap < 0) return () => true;
  const ranges: Array<[number, number]> = [];
  const n = dv.getUint16(cmap + 2);
  let best12 = -1, best4 = -1;
  for (let i = 0; i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = dv.getUint16(rec), encoding = dv.getUint16(rec + 2);
    const off = cmap + dv.getUint32(rec + 4);
    const fmt = dv.getUint16(off);
    if (platform === 3 && encoding === 10 && fmt === 12) best12 = off;
    if (platform === 3 && encoding === 1 && fmt === 4) best4 = off;
  }
  if (best12 >= 0) {
    const groups = dv.getUint32(best12 + 12);
    for (let g = 0; g < groups; g++) {
      const p = best12 + 16 + g * 12;
      ranges.push([dv.getUint32(p), dv.getUint32(p + 4)]);
    }
  } else if (best4 >= 0) {
    const segX2 = dv.getUint16(best4 + 6);
    const ends = best4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, offsets = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = dv.getUint16(ends + s * 2), start = dv.getUint16(starts + s * 2);
      const delta = dv.getUint16(deltas + s * 2), roff = dv.getUint16(offsets + s * 2);
      if (start === 0xffff) continue;
      if (roff === 0) { ranges.push([start, end]); continue; }
      for (let c = start; c <= end; c++) {
        const gi = dv.getUint16(offsets + s * 2 + roff + (c - start) * 2);
        if (gi !== 0 && ((gi + delta) & 0xffff) !== 0) ranges.push([c, c]);
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return (cp: number) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < ranges[mid][0]) hi = mid - 1;
      else if (cp > ranges[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

/** Characters in `text` the font cannot show (ignoring line breaks and other controls). */
export function missingCharacters(text: string, covers: (cp: number) => boolean): { count: number; examples: string[] } {
  const examples = new Set<string>();
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfeff || cp === 0x200b) continue;
    if (!covers(cp)) {
      count++;
      if (examples.size < 5) examples.add(ch);
    }
  }
  return { count, examples: [...examples] };
}
