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
  pdfMergeBytesPerDeviceGB: 128 * MB,
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
