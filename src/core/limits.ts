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
   * Holdouts of files not used to fit them (local/eval-8) raised the text figures per page and per byte, and added: for
   * text, per byte of page content once decoded (`content`: many small text items cost far more than their bytes) and
   * per byte of embedded font programs (`font`, which pdf.js reads and converts; fitted after content, which explained
   * most of what fonts seemed to cost, none in Firefox); for editing, per byte of page content (`content`: the cleanup
   * reads every page's content to see what it uses; Firefox needed none beyond its other figures). The content figures,
   * whose need varied most from one holdout to the next, are half again above the fit. The corrections were checked on
   * further unseen files.
   */
  pdfEditMemory: {
    v8: { base: 128 * MB, byte: 4.5, parsed: 48, page: 40 * 1024, stream: 1.5, output: 48 * 1024, list: 96 * 1024, copy: 2.5, content: 31 },
    gecko: { base: 256 * MB, byte: 4.5, parsed: 48, page: 40 * 1024, stream: 1.5, output: 64 * 1024, list: 96 * 1024, copy: 2.5, content: 0 },
    other: { base: 320 * MB, byte: 9.5, parsed: 128, page: 40 * 1024, stream: 7, output: 192 * 1024, list: 96 * 1024, copy: 2.5, content: 47 },
  },
  pdfTextMemory: {
    v8: { base: 128 * MB, byte: 3, parsed: 40, page: 68 * 1024, stream: 3.5, font: 7, content: 50 },
    gecko: { base: 256 * MB, byte: 7, parsed: 40, page: 120 * 1024, stream: 3.5, font: 0, content: 69 },
    other: { base: 320 * MB, byte: 10.5, parsed: 48, page: 180 * 1024, stream: 4, font: 11, content: 104 },
  },
  /**
   * Drawing PDF pages as pictures with pdf.js in the render worker (src/core/pdfmemory.ts, estimateRender): PDF to JPG
   * and PNG, and page previews. A base; per byte of the file, per byte parsed, per page pdf.js keeps (up to 50) and per
   * page drawn (Firefox frees what each page used later than Chrome); per byte of the largest stream; per pixel of the
   * largest picture in the file (decoded whole when its page is drawn: Chrome holds it several times over, as pdf.js's
   * bitmap and the smaller copies it draws from); per pixel of the page being drawn (`canvas`, or `masked` where the file
   * has soft masks, which take several page-sized canvases); and per byte of results held in memory where the browser has
   * no private storage for them. Fitted to peaks measured twice in Chrome and in Firefox, each set at least 10% above
   * every peak in its browser (local/PHASE2-TOOLKIT-v0.2.0.md). A holdout of files not used to fit them (local/eval-8)
   * added four: `jpx`, per pixel of the largest JPEG 2000 picture, whose decoder needs more than a JPEG's;
   * `drawnImage`, per pixel of the largest picture for each page drawn up to the 50 pdf.js keeps, since a page that
   * shows a large picture leaves memory the browser frees late (previews of a scanned PDF draw dozens at once); `font`,
   * per byte of embedded font programs, which pdf.js converts to draw with; and `content`, per byte of page content
   * once decoded (fitted before fonts; in Firefox it explained what fonts seemed to cost). They were checked again
   * on further unseen files. WebKit as Playwright runs it cannot draw in a worker, so it was not
   * measured: 'other' is 1.5 times the higher of Chrome and Firefox, part by part, and the base is higher.
   */
  pdfRenderMemory: {
    v8: { base: 160 * MB, byte: 3, parsed: 40, page: 48 * 1024, drawn: 8 * 1024, stream: 3.5, image: 32, jpx: 50, drawnImage: 2.75, canvas: 8, masked: 36, held: 1.5, font: 52, content: 26 },
    gecko: { base: 256 * MB, byte: 4.5, parsed: 40, page: 48 * 1024, drawn: 64 * 1024, stream: 3.5, image: 8, jpx: 22, drawnImage: 0.75, canvas: 8, masked: 36, held: 4, font: 0, content: 76 },
    other: { base: 320 * MB, byte: 6.75, parsed: 60, page: 72 * 1024, drawn: 96 * 1024, stream: 5.25, image: 48, jpx: 75, drawnImage: 4.25, canvas: 12, masked: 54, held: 6, font: 78, content: 114 },
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
  /**
   * The image optimization tools (src/core/imagememory.ts, estimateOptimize), for each engine: a base for the worker and
   * its codecs; per byte of the file (read, copied into the codec, the result); for Compress PNG per byte of decoded
   * samples (oxipng keeps the picture and its filtered trials); for lossless JPEG per DCT coefficient (the coefficients
   * read, and read again from the result to check it); for MozJPEG, libwebp and libavif per pixel, lossy and lossless
   * apart (the decoded picture, a copy, and the encoder's working memory; AVIF twice that at 10 and 12 bits); per pixel
   * for the similarity measure (the result decoded again); for Resize images per pixel decoded, then its result
   * format's encoder per pixel of the result (PNG, GIF and BMP: `encode`); per byte of the results the page holds; and
   * for each picture before in a batch, per picture and per pixel of it (memory the browser frees late).
   *
   * Fitted to peaks measured in Chrome (v8), Firefox (gecko) and WebKit as Playwright runs it on Windows: 36 single-file
   * workloads in three passes (one in WebKit), 16 of them run three more times, and 12 batches of up to 150 photos
   * (local/eval-7/mem), each figure the smallest that puts every estimate at least 10% above the highest peak seen (the
   * same work in Chrome sometimes peaks about half again higher). 'other' (Safari and browsers not told apart) is 1.5
   * times the higher of v8 and gecko for each part, and never below what WebKit needed. A holdout of files not used to
   * fit them (local/eval-8) raised the lossless WebP figure (photos need more than the screenshots fitted), and
   * Firefox's MozJPEG, decoding and per-pixel batch figures, and added `perPixelAvif`, per pixel of each picture before
   * in a batch whose results are AVIF (Firefox frees what libavif used later than any other encoder's memory, and more
   * so the longer the batch): fitted to every AVIF batch measured, with half again on top. The corrections were checked
   * on further unseen files.
   */
  imageOptMemory: {
    v8: { base: 96 * MB, byte: 4, png: 27, coefficient: 9.5, mozjpeg: 41, webp: 21, webpLossless: 93, avif: 90, avifLossless: 139, measure: 3, decode: 8.25, encode: 30, held: 1, perFile: 1.5 * MB, perPixel: 0.08, perPixelAvif: 0.08 },
    gecko: { base: 112 * MB, byte: 4, png: 31, coefficient: 9, mozjpeg: 37, webp: 18, webpLossless: 86, avif: 84, avifLossless: 130, measure: 5, decode: 20, encode: 34, held: 1, perFile: 2 * MB, perPixel: 0.66, perPixelAvif: 1.6 },
    other: { base: 176 * MB, byte: 6, png: 64, coefficient: 14.25, mozjpeg: 62, webp: 32, webpLossless: 140, avif: 135, avifLossless: 209, measure: 18.5, decode: 30, encode: 51, held: 1.5, perFile: 10.5 * MB, perPixel: 0.99, perPixelAvif: 2.4 },
  },
  /** Image optimization: files at once in one tool. */
  imageOptFiles: 500,
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
