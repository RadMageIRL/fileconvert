// Size limits. They keep a hostile or simply enormous file from exhausting the browser's memory. Each
// limit is checked before the expensive step it protects, and the error says which limit was hit.

const MB = 1024 * 1024;

export const LIMITS = {
  /** Image files, and the decoded picture. 100 megapixels is about 400 MB of RGBA pixels. */
  imageBytes: 300 * MB,
  imagePixels: 100_000_000,
  imageSide: 30_000,
  /** SVG source text. */
  svgBytes: 20 * MB,
  /** Pages read from one multi-page TIFF, and pages in one TIFF written. */
  tiffPages: 1000,
  /** All the pages of one TIFF written together: about 1.6 GB of pixels at most while it is built. */
  tiffTotalPixels: 400_000_000,
  /** Audio and video inputs are read in pieces, so they may be large. */
  mediaBytes: 8 * 1024 * MB,
  /** Results kept in memory when the browser has no private file storage for them. */
  mediaInMemoryBytes: 1536 * MB,
  /** GIF output from video: frames are held as a growing file. */
  gifFrames: 900,
  gifMaxWidth: 1280,
  /** Animated GIF input converted to video. */
  gifInputFrames: 5000,
  gifInputPixels: 2_000_000_000,
  /** Documents. */
  pdfBytes: 500 * MB,
  pdfPages: 5000,
  /**
   * What the PDF guard (src/engines/pdf/scan.ts) allows before any PDF library reads a file, measured by decoding
   * every compressed stream as a count, never by trusting declared sizes: the decoded size of one stream (at every
   * filter in a chain), of all streams together, and of the object streams a PDF library keeps in memory; the
   * number of objects; the pixels of one picture (from its dictionary and from the JPEG or JPEG 2000 header itself);
   * the samples of one sampled function; and the bytes of one row a predictor or fax decoder works on.
   */
  pdfStreamBytes: 256 * MB,
  pdfDecodedBytes: 4096 * MB,
  pdfObjectStreamBytes: 256 * MB,
  pdfObjects: 500_000,
  pdfImagePixels: 100_000_000,
  pdfFunctionSamples: 10_000_000,
  pdfRowBytes: 4 * MB,
  /**
   * Merge PDFs: files at once, and their size together. The merge holds the result as it grows plus one file at a
   * time, then writes the result whole: 863 MB in three files raised Chrome's memory by 2.1 to 2.7 GB. Where the
   * browser says how much memory the device has (Chrome, Edge), the size is also capped per gigabyte of it.
   */
  pdfMergeFiles: 200,
  pdfMergeBytes: 1024 * MB,
  /**
   * The memory admission check for PDF work (src/core/pdfmemory.ts): every PDF task is refused before it starts when
   * its estimate is more than one task may use. One task may use half the memory the browser reports for the device,
   * or, where it reports none (Firefox, Safari), what half of a modest device would be: 2 GB on a computer (4 GB
   * assumed), 1 GB on a phone or tablet (2 GB assumed); 4 GB at most. Where the browser reports its JavaScript heap
   * limit (Chrome, Edge), the part of the estimate that lives in that heap is held to 3/4 of it, less a reserve for
   * the page and the code.
   */
  pdfMemoryDeviceShare: 0.5,
  pdfMemoryAssumedComputer: 2048 * MB,
  pdfMemoryAssumedPhone: 1024 * MB,
  pdfMemoryCeiling: 4096 * MB,
  pdfHeapReserve: 120 * MB,
  pdfHeapShare: 0.9,
  /**
   * The part of an estimate that has to fit in the JavaScript heap at once, for the check against the heap limit Chrome
   * and Edge report (less the reserve, which Chrome adds to its limit for the young generation: a 128 MB heap reads as
   * 239 MB): per byte parsed into objects, per page and per file made. Fitted to where Chrome, its heap capped, stopped
   * responding: the densest file measured, 9.5 MB of empty dictionaries, froze a 192 MB heap and completed in 256 MB.
   */
  pdfHeapMemory: { parsed: 32, page: 16 * 1024, output: 16 * 1024 },
  /**
   * The estimate, from what the PDF guard counted, for each engine (src/core/pdfmemory.ts, MemoryEngine): a base for the
   * code and the worker; then per byte of the file; per byte parsed into objects (dictionaries, arrays, the decoded
   * object streams: the densest, empty dictionaries, cost Chrome about 30 times their bytes and WebKit more); per page;
   * per byte of the largest stream once decoded (page content is decoded one stream at a time). For the editing tools
   * also: per file made, per page shown in the reorder tool's page list, and per byte the new files hold beyond the
   * input (split copies the pictures and fonts its pages share into every part, and the result is held twice while it
   * is handed to the page). Objects are counted but not priced: the bytes parsed cover them. Each set is above every
   * peak measured in its browser, by 10% at least (local/PHASE2-MEMORY-v0.2.0.md). Text is pdf.js reading text.
   */
  pdfEditMemory: {
    v8: { base: 128 * MB, byte: 4.5, parsed: 48, page: 40 * 1024, stream: 1.5, output: 48 * 1024, list: 96 * 1024, copy: 2.5 },
    gecko: { base: 256 * MB, byte: 4.5, parsed: 48, page: 40 * 1024, stream: 1.5, output: 64 * 1024, list: 96 * 1024, copy: 2.5 },
    other: { base: 320 * MB, byte: 9.5, parsed: 128, page: 40 * 1024, stream: 7, output: 192 * 1024, list: 96 * 1024, copy: 2.5 },
  },
  pdfTextMemory: {
    v8: { base: 128 * MB, byte: 3, parsed: 40, page: 48 * 1024, stream: 3.5 },
    gecko: { base: 256 * MB, byte: 4.5, parsed: 40, page: 48 * 1024, stream: 3.5 },
    other: { base: 320 * MB, byte: 4.5, parsed: 48, page: 64 * 1024, stream: 4 },
  },
  /**
   * Images to PDF (src/engines/pdf/images.ts): pictures in one PDF, and what the PDF may hold in all. Pictures are read
   * one at a time; each is the same size limit as any image (imageBytes, imagePixels, imageSide), and the pages, with
   * a multi-page TIFF's, are no more than pdfPages.
   */
  imagePdfFiles: 500,
  imagePdfBytes: 2048 * MB,
  /**
   * The memory estimate for Images to PDF (src/core/pdfmemory.ts, estimateImages), for each engine: a base; per byte
   * the PDF holds (`held`: kept while the next pictures are added, then written out whole and handed to the page);
   * for the one picture being added, per byte of its file (`copy`: read and copied once), per byte of its decoded
   * samples when a PNG is decoded here (`planes`), or per pixel when the browser decodes it (`pixel`: its bitmap, a
   * canvas, the pixels read back, and the planes made from them); and per page. A JPEG or a PNG that goes in as it is
   * is never decoded, so it costs its bytes only; each page costs most for many small pictures (each is checked as it is
   * added, listed, and becomes PDF objects). Fitted to peaks measured in Chrome, Firefox and WebKit as Playwright runs it
   * on Windows (not Safari), each set at least 10% above every peak in its browser; 'other' is at least the highest of
   * them, part by part, and is all an unknown engine gets. WebKit held a PDF of pictures at seven to eight times its bytes.
   * Pictures the browser decodes (WebP, GIF, BMP) were not measured in WebKit, which has no OffscreenCanvas there.
   */
  imagePdfMemory: {
    v8: { base: 128 * MB, held: 3.5, copy: 3, planes: 3, pixel: 24, page: 768 * 1024 },
    gecko: { base: 256 * MB, held: 3.5, copy: 3, planes: 3, pixel: 24, page: 1536 * 1024 },
    other: { base: 320 * MB, held: 7.5, copy: 3, planes: 5, pixel: 40, page: 1536 * 1024 },
  },
  textToPdfBytes: 8 * MB,
  markupBytes: 8 * MB,
  docxBytes: 200 * MB,
  /** Pictures carried inside one HTML or Markdown result from a DOCX, as data URLs. */
  docxPictureBytes: 100 * MB,
  /** Data files, and how far nested structures may go. */
  dataBytes: 200 * MB,
  dataDepth: 500,
  csvCells: 50_000_000,
  /** JSON Lines: values read from one file. */
  jsonlLines: 10_000_000,
  xlsxBytes: 200 * MB,
  xlsxRows: 1_048_576,
  xlsxColumns: 16_384,
  /** ZIP containers (DOCX, XLSX): what their parts may inflate to. */
  zipEntries: 20_000,
  zipInflatedBytes: 1024 * MB,
  zipRatio: 1000,
  /** Archives that are unpacked: files, bytes unpacked in all (in private storage, or in memory without it), and
   *  the expansion that marks a decompression bomb once a file is past 64 MB. */
  archiveEntries: 10_000,
  archiveBytes: 4096 * MB,
  archiveInMemoryBytes: 1024 * MB,
  archiveRatio: 1000,
  archiveRatioFloor: 64 * MB,
  /** The batch ZIP download. */
  batchZipBytes: 4000 * MB,
} as const;

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}
