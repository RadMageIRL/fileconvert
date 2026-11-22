// Size limits. They keep a hostile or simply enormous file from exhausting the browser's memory. Each
// limit is checked before the expensive step it protects, and the error says which limit was hit.

const MB = 1024 * 1024;

export const LIMITS = {
  /** Image files, and the decoded picture. 100 megapixels is about 400 MB of RGBA pixels. */
  imageBytes: 300 * MB,
  imagePixels: 100_000_000,
  imageSide: 30_000,
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
  textToPdfBytes: 8 * MB,
  markupBytes: 8 * MB,
  docxBytes: 200 * MB,
  /** Data files, and how far nested structures may go. */
  dataBytes: 200 * MB,
  dataDepth: 500,
  csvCells: 50_000_000,
  xlsxBytes: 200 * MB,
  xlsxRows: 1_048_576,
  xlsxColumns: 16_384,
  /** ZIP containers (DOCX, XLSX): what their parts may inflate to. */
  zipEntries: 20_000,
  zipInflatedBytes: 1024 * MB,
  zipRatio: 1000,
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
