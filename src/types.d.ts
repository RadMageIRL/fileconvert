declare module 'html-to-pdfmake' {
  const htmlToPdfmake: (html: string, options?: Record<string, unknown>) => unknown;
  export default htmlToPdfmake;
}

declare module 'gifenc' {
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: Record<string, unknown>): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: Record<string, unknown>): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}

declare module 'utif' {
  const UTIF: {
    encodeImage(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, metadata?: Record<string, unknown>): ArrayBuffer;
    decode(buf: ArrayBuffer | Uint8Array): unknown[];
    decodeImage(buf: ArrayBuffer | Uint8Array, ifd: unknown, ifds: unknown[]): void;
    toRGBA8(ifd: unknown): Uint8Array;
  };
  export default UTIF;
}

declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  const factory: () => Promise<unknown>;
  export default factory;
}

declare module 'pdfmake/build/pdfmake.js' {
  const pdfMake: unknown;
  export default pdfMake;
}

declare module 'mammoth' {
  export function convertToHtml(o: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>): Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
  export const images: { imgElement(f: (image: unknown) => Promise<Record<string, string>>): unknown };
}

declare module '@jsquash/avif/codec/enc/avif_enc.js' {
  const factory: (opts: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
declare module '@jsquash/avif/codec/dec/avif_dec.js' {
  const factory: (opts: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
declare module '@jsquash/webp/codec/enc/webp_enc.js' {
  const factory: (opts: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
declare module '@jsquash/webp/meta.js' {
  export const defaultOptions: Record<string, unknown>;
}
