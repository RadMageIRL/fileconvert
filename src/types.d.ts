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
  export interface MammothImage { contentType?: string; altText?: string; read(encoding: 'base64'): Promise<string> }
  export const images: { imgElement(f: (image: MammothImage) => Promise<Record<string, string>>): unknown };
  export interface MammothElement { type: string; children?: MammothElement[]; styleName?: string | null; styleId?: string | null; font?: string | null; value?: string; [k: string]: unknown }
  export const transforms: { paragraph(f: (p: MammothElement) => MammothElement): (doc: unknown) => unknown };
}

declare module 'turndown' {
  interface Rule { filter: string | string[] | ((node: HTMLElement, options: Record<string, unknown>) => boolean); replacement: (content: string, node: HTMLElement, options: Record<string, unknown>) => string }
  export default class TurndownService {
    constructor(options?: Record<string, unknown>);
    use(plugin: (service: TurndownService) => void): this;
    addRule(key: string, rule: Rule): this;
    keep(filter: string | string[] | ((node: HTMLElement) => boolean)): this;
    remove(filter: string | string[] | ((node: HTMLElement) => boolean)): this;
    turndown(html: string | Node): string;
    escape(text: string): string;
  }
}

declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
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
