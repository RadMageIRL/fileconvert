// PDF writing with pdfmake, inside the document worker. pdfmake lays out text, lists, tables and links
// with real, selectable text and embeds subsets of the Noto fonts. Its URL loader is switched off, so a
// document can never make it fetch anything: images must already be data inside the document.

import { cmapCoverage, FONT_FAMILIES, FONT_FILES, missingCharacters, type FontFile } from './fonts';

type PdfMake = {
  addVirtualFileSystem(vfs: Record<string, { data: Uint8Array; encoding?: string }>): void;
  addFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(cb: (url: string) => boolean): void;
  createPdf(doc: unknown): { getBuffer(): Promise<Uint8Array> };
};

let pdfmake: Promise<PdfMake> | null = null;
const loaded = new Map<FontFile, Uint8Array>();
const coverage = new Map<FontFile, (cp: number) => boolean>();

async function getPdfMake(): Promise<PdfMake> {
  if (!pdfmake) {
    pdfmake = import('pdfmake/build/pdfmake.js').then(m => {
      const lib = ((m as unknown as { default?: PdfMake }).default ?? m) as PdfMake;
      lib.setUrlAccessPolicy(() => false);
      lib.addFonts(FONT_FAMILIES as unknown as Record<string, Record<string, string>>);
      return lib;
    });
  }
  return pdfmake;
}

async function loadFonts(files: FontFile[]): Promise<void> {
  const missing = files.filter(f => !loaded.has(f));
  const fetched = await Promise.all(missing.map(async f => {
    const res = await fetch(new URL(FONT_FILES[f], self.location.href));
    if (!res.ok) throw new Error(`The PDF font ${f} could not be loaded (${res.status}). Check your connection and try again.`);
    return [f, new Uint8Array(await res.arrayBuffer())] as const;
  }));
  const lib = await getPdfMake();
  const vfs: Record<string, { data: Uint8Array }> = {};
  for (const [f, bytes] of fetched) {
    loaded.set(f, bytes);
    vfs[f] = { data: bytes };
  }
  if (fetched.length) lib.addVirtualFileSystem(vfs);
}

/** Fonts a document definition needs: the sans family always, mono where code or plain text appears. */
export function fontsFor(mono: boolean, sans: boolean): FontFile[] {
  const list: FontFile[] = [];
  if (sans) list.push('NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf', 'NotoSans-BoldItalic.ttf');
  if (mono) list.push('NotoSansMono-Regular.ttf', 'NotoSansMono-Bold.ttf');
  return list;
}

export async function missingIn(text: string, font: FontFile): Promise<{ count: number; examples: string[] }> {
  await loadFonts([font]);
  let cov = coverage.get(font);
  if (!cov) { cov = cmapCoverage(loaded.get(font)!); coverage.set(font, cov); }
  return missingCharacters(text, cov);
}

export async function renderPdf(doc: Record<string, unknown>, fonts: FontFile[]): Promise<Uint8Array> {
  await loadFonts(fonts);
  const lib = await getPdfMake();
  const out = await lib.createPdf({
    ...doc,
    info: { producer: 'FileConvert', creator: 'FileConvert', ...(doc.info as object | undefined) },
  }).getBuffer();
  return out instanceof Uint8Array ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength) : new Uint8Array(out as ArrayBuffer);
}
