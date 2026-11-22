// The dedicated pages: one per conversion or tool that has its own address, such as /fileconvert/heic-to-jpg/.
// This is the single list the page generator (src/site/render.ts), the catalog, the sitemap and the tests
// read. A conversion page names a pair from the format registry, and the build fails if that pair is not
// one FileConvert performs, so a page can never advertise a conversion that does not exist.
//
// The text is written per page and describes what the engines really do. Keep it accurate when an engine
// changes. It must stay plain ASCII (the house rules check source files).

import { FORMATS, type Category, type FormatId } from './formats.ts';

export interface ConversionPage {
  slug: string;
  from: FormatId;
  to: FormatId;
  /** Where the page is listed in the catalog. */
  category: Category;
  /** Short line under the name in the catalog. */
  blurb: string;
  /** Meta description, 70 to 160 characters, unique. */
  description: string;
  /** The first paragraph under the heading. */
  intro: string;
  /** What happens to the file, specific to this conversion. */
  details: string[];
  /** Limits and things that change, specific to this conversion. */
  limits: string[];
  /** Slugs of related pages. */
  related: string[];
  /** Extra search words (synonyms, devices, apps). */
  keywords?: string[];
  /** Position in the Common conversions list on the home page. */
  common?: number;
}

/** The page's display name, such as "HEIC to JPG". */
export const pageName = (p: ConversionPage) => `${FORMATS[p.from].label} to ${FORMATS[p.to].label}`;

/** The page title, at most 60 characters. */
export const pageTitle = (p: ConversionPage) => `${pageName(p)} Converter, Free and Private | FileConvert`;

const PRIVATE_PHOTO = 'The photo is turned the right way up, and its EXIF details (camera, date, GPS location) are not copied into the result.';

export const PAGES: readonly ConversionPage[] = [
  // ------------------------------------------------------------------ images
  {
    slug: 'heic-to-jpg', from: 'heic', to: 'jpg', category: 'image', common: 1,
    blurb: 'iPhone photos for any app',
    description: 'Convert iPhone and iPad HEIC photos to JPG in your browser. Nothing is uploaded: every photo is converted on your device. Free, no sign-up.',
    intro: 'HEIC (High Efficiency Image File Format) is how iPhones and iPads save photos by default. JPG opens everywhere: on Windows, in older apps, on websites and in email.',
    details: [
      'The main picture in each HEIC file is decoded on your device by libheif, compiled to WebAssembly. It downloads once, the first time you convert a HEIC file.',
      'JPG quality is 85 out of 100 unless you change it in Images settings, where you can also resize by percent or to fit a box.',
      PRIVATE_PHOTO,
      'Transparent areas, rare in photos, are filled with the background color you choose (white unless you change it).',
    ],
    limits: [
      'HEIC color profiles are not applied, so wide-gamut photos (Display P3) can look slightly less vivid.',
      'A HEIC file holding several pictures, such as a burst, gives its main picture, with a note.',
      'Photos up to 100 megapixels and 300 MB.',
    ],
    related: ['heic-to-png', 'png-to-jpg', 'webp-to-jpg', 'avif-to-jpg'],
    keywords: ['iphone', 'ipad', 'apple', 'photo', 'photos'],
  },
  {
    slug: 'heic-to-png', from: 'heic', to: 'png', category: 'image',
    blurb: 'Lossless copies of iPhone photos',
    description: 'Turn HEIC photos from an iPhone or iPad into lossless PNG files, right in your browser. Photos stay on your device and are never uploaded.',
    intro: 'PNG stores every pixel exactly and keeps transparency, which makes it a good choice for editing or archiving a HEIC photo without adding JPG compression. The files are larger than JPG.',
    details: [
      'Each HEIC file is decoded on your device by libheif (WebAssembly), downloaded once on first use.',
      'The PNG holds the decoded pixels without further loss, and transparency is kept.',
      PRIVATE_PHOTO,
      'You can resize by percent or to fit a box in Images settings; resizing never enlarges.',
    ],
    limits: [
      'Expect PNG files several times larger than the HEIC original: HEIC compresses far more.',
      'HEIC color profiles are not applied, so wide-gamut photos can look slightly less vivid.',
      'Photos up to 100 megapixels and 300 MB.',
    ],
    related: ['heic-to-jpg', 'jpg-to-png', 'webp-to-png', 'png-to-webp'],
    keywords: ['iphone', 'ipad', 'apple', 'photo', 'lossless'],
  },
  {
    slug: 'webp-to-png', from: 'webp', to: 'png', category: 'image', common: 2,
    blurb: 'Web images for any editor',
    description: 'Convert WebP images saved from websites into PNG, keeping transparency. Free and private: images are converted in your browser, never uploaded.',
    intro: 'Many websites serve pictures as WebP, so saving an image often gives you a .webp file. PNG is understood by every editor and keeps transparent backgrounds.',
    details: [
      'Your browser decodes the WebP itself; nothing extra needs to download.',
      'The PNG is lossless, so it looks exactly like the decoded WebP, transparency included.',
      'Metadata such as EXIF is not copied.',
      'Resize by percent or to fit a box in Images settings if you need a smaller picture.',
    ],
    limits: [
      'An animated WebP becomes its first frame, with a note.',
      'PNG files are usually larger than the WebP original.',
    ],
    related: ['webp-to-jpg', 'png-to-webp', 'png-to-jpg', 'avif-to-jpg'],
    keywords: ['website', 'web', 'download', 'transparent'],
  },
  {
    slug: 'webp-to-jpg', from: 'webp', to: 'jpg', category: 'image',
    blurb: 'Web images as universal JPG',
    description: 'Convert WebP pictures to JPG for apps and sites that do not accept WebP. Runs in your browser with no upload, no account and no watermark.',
    intro: 'Some older apps, upload forms and photo services still refuse WebP. JPG is accepted nearly everywhere and keeps photos small.',
    details: [
      'Your browser decodes the WebP; JPG quality is 85 out of 100 unless you change it in Images settings.',
      'JPG has no transparency, so transparent areas are filled with the background color you choose (white unless you change it), and the result says so.',
      'Metadata such as EXIF is not copied.',
    ],
    limits: [
      'An animated WebP becomes its first frame, with a note.',
      'JPG is lossy: each conversion loses a little detail. Use PNG if you need an exact copy.',
    ],
    related: ['webp-to-png', 'png-to-jpg', 'heic-to-jpg', 'avif-to-jpg'],
    keywords: ['website', 'web', 'jpeg'],
  },
  {
    slug: 'png-to-jpg', from: 'png', to: 'jpg', category: 'image', common: 3,
    blurb: 'Smaller files from screenshots and graphics',
    description: 'Convert PNG images to smaller JPG files, with your choice of quality and a background color for transparent areas. Private, in your browser.',
    intro: 'PNG is ideal for screenshots and graphics, but photos saved as PNG are large. JPG makes them much smaller for email, uploads and websites.',
    details: [
      'Quality is 85 out of 100 unless you change it in Images settings; lower values give smaller files.',
      'JPG cannot be transparent, so transparent areas are filled with the background color you pick (white unless you change it). The result notes when that happened.',
      'Resize by percent or to fit a box at the same time.',
    ],
    limits: [
      'JPG is lossy and blurs sharp edges and text slightly. For screenshots with text, WebP or PNG usually look better.',
      'Pictures up to 100 megapixels and 300 MB.',
    ],
    related: ['jpg-to-png', 'png-to-webp', 'webp-to-jpg', 'heic-to-jpg'],
    keywords: ['screenshot', 'jpeg', 'compress', 'smaller'],
  },
  {
    slug: 'jpg-to-png', from: 'jpg', to: 'png', category: 'image',
    blurb: 'Lossless copies for editing',
    description: 'Convert JPG photos to PNG for lossless editing or for tools that require PNG. Works offline in your browser once loaded; nothing is uploaded.',
    intro: 'PNG is lossless: once a picture is a PNG, editing and saving it again adds no further compression. Some tools and sites also require PNG.',
    details: [
      PRIVATE_PHOTO,
      'The PNG holds exactly the pixels the JPG decodes to.',
      'Resize by percent or to fit a box in Images settings.',
    ],
    limits: [
      'PNG cannot restore detail the JPG compression already removed.',
      'Expect the PNG to be several times larger than the JPG.',
    ],
    related: ['png-to-jpg', 'heic-to-png', 'webp-to-png', 'png-to-webp'],
    keywords: ['jpeg', 'lossless', 'photo'],
  },
  {
    slug: 'png-to-webp', from: 'png', to: 'webp', category: 'image',
    blurb: 'Smaller images for websites',
    description: 'Convert PNG images to WebP for faster websites, keeping transparency. Choose the quality; images are processed on your device, never uploaded.',
    intro: 'WebP is much smaller than PNG for photos and most graphics, keeps transparency, and every current browser shows it. It is a common choice for web pages.',
    details: [
      'Quality is 85 out of 100 unless you change it in Images settings; it trades file size for detail.',
      'Transparency is kept.',
      'Where a browser cannot write WebP itself, FileConvert uses libwebp compiled to WebAssembly instead.',
      'Resize by percent or to fit a box at the same time.',
    ],
    limits: [
      'This WebP is lossy, so it is not a byte-exact copy of the PNG.',
      'Animated PNG (APNG) becomes its first frame, with a note.',
    ],
    related: ['webp-to-png', 'png-to-jpg', 'jpg-to-png', 'heic-to-png'],
    keywords: ['website', 'web', 'compress', 'smaller', 'transparent'],
  },
  {
    slug: 'avif-to-jpg', from: 'avif', to: 'jpg', category: 'image',
    blurb: 'Modern AVIF to universal JPG',
    description: 'Convert AVIF images to JPG so they open in any app. Decoded by your browser or a WebAssembly decoder, entirely on your device. Free.',
    intro: 'AVIF makes very small image files, but many apps and services cannot open it yet. JPG works everywhere.',
    details: [
      'The browser decodes AVIF where it can; otherwise FileConvert uses libavif compiled to WebAssembly, downloaded once.',
      'JPG quality is 85 out of 100 unless you change it in Images settings.',
      'Transparent areas are filled with the background color you choose (white unless you change it).',
      'Metadata such as EXIF is not copied.',
    ],
    limits: [
      'Animated AVIF becomes its first frame.',
      'HDR and wide-gamut AVIF images are converted to standard colors and can look flatter.',
    ],
    related: ['heic-to-jpg', 'webp-to-jpg', 'png-to-jpg', 'jpg-to-png'],
    keywords: ['jpeg', 'modern'],
  },
  {
    slug: 'gif-to-mp4', from: 'gif', to: 'mp4', category: 'image',
    blurb: 'Animated GIFs as small videos',
    description: 'Turn animated GIFs into MP4 videos that are a fraction of the size and play everywhere. Converted with your browser\'s encoder, never uploaded.',
    intro: 'Animated GIFs are large and limited to 256 colors. The same animation as an H.264 MP4 is usually far smaller, and sites and chat apps play it smoothly.',
    details: [
      'Every frame is decoded and composited the way GIF viewers show it, and each frame keeps its timing.',
      'The video is encoded with your browser\'s own H.264 encoder (WebCodecs), often on the graphics chip.',
      'Transparent areas are filled with the background color set in Images settings.',
    ],
    limits: [
      'Needs WebCodecs: current Chrome, Edge and Firefox have it.',
      'GIFs up to 5,000 frames.',
      'A still (single-frame) GIF is offered as a picture conversion instead.',
    ],
    related: ['mp4-to-gif', 'webm-to-mp4', 'mov-to-mp4', 'png-to-webp'],
    keywords: ['animated', 'animation', 'video', 'meme'],
  },
  // ------------------------------------------------------------------ audio
  {
    slug: 'mp4-to-mp3', from: 'mp4', to: 'mp3', category: 'audio', common: 4,
    blurb: 'The soundtrack of a video',
    description: 'Extract the audio from MP4 videos as MP3, with your choice of bitrate. Videos up to 8 GB are converted in your browser and never uploaded.',
    intro: 'Keep just the sound of a video: a recorded talk, a music video or a voice note filmed on a phone. MP3 plays on every device.',
    details: [
      'The video track is skipped and only the first audio track is decoded and encoded as MP3 with LAME, compiled to WebAssembly.',
      'Bitrate is automatic (high quality) unless you choose 96 to 320 kbit/s in Audio settings; sample rate and mono or stereo can be set too.',
      'Descriptive tags such as title and artist are kept; raw container metadata, which can include a phone\'s recording location, is not.',
      'Large results are written to your browser\'s private storage for this site, not held in memory, and deleted when you clear the list or close the tab.',
    ],
    limits: [
      'Files up to 8 GB.',
      'If the video holds several audio tracks, the first is converted, with a note.',
      'Sound this browser cannot decode (AC-3 outside Edge, for example) is reported instead of converted.',
    ],
    related: ['mov-to-mp4', 'm4a-to-mp3', 'wav-to-mp3', 'mp4-to-gif'],
    keywords: ['audio', 'extract', 'soundtrack', 'music', 'video'],
  },
  {
    slug: 'wav-to-mp3', from: 'wav', to: 'mp3', category: 'audio',
    blurb: 'Uncompressed audio, a tenth of the size',
    description: 'Compress WAV recordings to MP3 at the bitrate you choose, about a tenth of the size at 128 kbit/s. Converted on your device, nothing uploaded.',
    intro: 'WAV is uncompressed, so a few minutes of recording can take tens of megabytes. MP3 makes it small enough to email or share while sounding close to the original.',
    details: [
      'Encoded with LAME, compiled to WebAssembly, at an automatic high-quality bitrate unless you choose 96 to 320 kbit/s in Audio settings.',
      'Sample rate and mono or stereo can be changed in the same settings, or kept as they are.',
      'Long recordings are fine: the file is read in pieces and the result goes to your browser\'s private storage.',
    ],
    limits: [
      'MP3 is lossy. Keep the WAV, or convert to FLAC, if you need an exact copy.',
      'Files up to 8 GB.',
    ],
    related: ['flac-to-mp3', 'm4a-to-mp3', 'mp4-to-mp3'],
    keywords: ['audio', 'recording', 'compress', 'wave'],
  },
  {
    slug: 'm4a-to-mp3', from: 'm4a', to: 'mp3', category: 'audio', common: 7,
    blurb: 'Voice memos and iTunes audio as MP3',
    description: 'Convert M4A files, such as iPhone voice memos and iTunes downloads, to MP3. Tags stay with the file; all processing happens in your browser.',
    intro: 'M4A is AAC audio in an MP4 file, used by iPhone Voice Memos, iTunes and many recorders. MP3 is accepted by more players, cars and older devices.',
    details: [
      'The AAC audio is decoded by your browser and encoded as MP3 with LAME (WebAssembly).',
      'Title, artist, album and cover art are kept.',
      'Choose the bitrate in Audio settings; a higher bitrate limits the loss of converting one lossy format to another.',
    ],
    limits: [
      'Purchases protected with DRM (M4P) cannot be converted, and FileConvert says so.',
      'Apple Lossless (ALAC) M4A files are not supported: no browser can decode ALAC.',
    ],
    related: ['mp4-to-mp3', 'wav-to-mp3', 'flac-to-mp3'],
    keywords: ['audio', 'voice memo', 'itunes', 'aac', 'iphone', 'apple'],
  },
  {
    slug: 'flac-to-mp3', from: 'flac', to: 'mp3', category: 'audio',
    blurb: 'Lossless music for any player',
    description: 'Convert FLAC music to MP3 for phones, cars and players without FLAC support. Tags and cover art are kept, and nothing leaves your device.',
    intro: 'FLAC keeps music lossless, but many cars, older players and some apps do not play it. MP3 at a high bitrate is a practical copy for those.',
    details: [
      'Encoded with LAME (WebAssembly); choose 96 to 320 kbit/s in Audio settings, or leave it automatic.',
      'Title, artist, album, track number and cover art are kept.',
      'High-resolution FLAC can be set to 44.1 or 48 kHz in Audio settings.',
    ],
    limits: [
      'Audio with more than two channels is mixed down to stereo, with a note.',
      'MP3 is lossy; keep the FLAC as your master copy.',
    ],
    related: ['wav-to-mp3', 'm4a-to-mp3', 'mp4-to-mp3'],
    keywords: ['audio', 'music', 'lossless', 'album'],
  },
  // ------------------------------------------------------------------ video
  {
    slug: 'mov-to-mp4', from: 'mov', to: 'mp4', category: 'video', common: 5,
    blurb: 'iPhone and camera videos as MP4',
    description: 'Convert MOV videos from an iPhone or camera to MP4. H.264 video is copied without re-encoding when possible. Private: nothing is uploaded.',
    intro: 'MOV is Apple\'s QuickTime format, used by iPhones and many cameras. MP4 is built the same way and plays on almost everything, including Windows, Android and video sites.',
    details: [
      'With Quality set to Original, H.264 video and AAC audio are copied into the MP4 without re-encoding, which is fast and lossless.',
      'Other video, such as HEVC from recent iPhones, is re-encoded to H.264 with your browser\'s encoder (WebCodecs).',
      'Resolution (2160p down to 360p) and quality can be set in Video settings, and the sound can be removed.',
      'The video keeps its rotation, so portrait clips stay upright.',
    ],
    limits: [
      'HEVC video needs a browser that can decode it: Chrome and Edge on recent Windows and macOS usually can, Firefox cannot.',
      'HDR video that is re-encoded is not tone-mapped and can look washed out.',
      'Files up to 8 GB.',
    ],
    related: ['mkv-to-mp4', 'webm-to-mp4', 'mp4-to-mp3', 'mp4-to-gif'],
    keywords: ['iphone', 'quicktime', 'apple', 'camera', 'video'],
  },
  {
    slug: 'mkv-to-mp4', from: 'mkv', to: 'mp4', category: 'video',
    blurb: 'Matroska video for any player',
    description: 'Convert MKV videos to MP4 for TVs, phones and editors. Compatible streams are copied, not re-encoded. Runs in your browser, nothing uploaded.',
    intro: 'MKV (Matroska) can hold almost any codec, but many TVs, phones and editing apps only accept MP4.',
    details: [
      'With Quality set to Original, H.264 video and AAC audio are copied without re-encoding; other video is re-encoded to H.264 and other sound to AAC.',
      'FileConvert keeps the first video track and the first audio track, and notes any others.',
      'Resolution and quality can be set in Video settings, and the sound can be removed.',
    ],
    limits: [
      'Films often carry AC-3 or DTS sound. Edge decodes AC-3; in other browsers the picture is converted without sound, and FileConvert says so first.',
      'HEVC video needs a browser that can decode it (usually Chrome and Edge, not Firefox).',
      'Files up to 8 GB.',
    ],
    related: ['mov-to-mp4', 'webm-to-mp4', 'mp4-to-mp3'],
    keywords: ['matroska', 'video', 'movie', 'film', 'tv'],
  },
  {
    slug: 'webm-to-mp4', from: 'webm', to: 'mp4', category: 'video',
    blurb: 'Browser recordings for editors and phones',
    description: 'Convert WebM videos, such as screen and browser recordings, to MP4 with H.264 video and AAC sound. Encoded on your device, never uploaded.',
    intro: 'WebM is what browsers and many screen recorders produce. Video editors, iPhones and some players need MP4 with H.264 instead.',
    details: [
      'VP8, VP9 or AV1 video is re-encoded to H.264 and Opus or Vorbis sound to AAC, using your browser\'s encoders (WebCodecs).',
      'Where the browser has no AAC encoder, the FFmpeg AAC encoder, compiled to WebAssembly, is used.',
      'Resolution and quality can be set in Video settings; Medium or Low give smaller files.',
    ],
    limits: [
      'Re-encoding takes time on long videos, and is faster where the graphics chip encodes H.264.',
      'Files up to 8 GB.',
    ],
    related: ['mkv-to-mp4', 'mov-to-mp4', 'mp4-to-gif', 'gif-to-mp4'],
    keywords: ['screen recording', 'video', 'browser'],
  },
  {
    slug: 'mp4-to-gif', from: 'mp4', to: 'gif', category: 'video', common: 6,
    blurb: 'Short clips as animated GIFs',
    description: 'Make an animated GIF from an MP4 clip, choosing its width and frame rate. The video is decoded and the GIF built in your browser, not uploaded.',
    intro: 'Animated GIFs play everywhere without a video player, which makes them handy for short clips in chats, documentation and bug reports.',
    details: [
      'Choose the width (320 to 800 pixels, 480 unless you change it) and the frame rate (5 to 20 frames per second, 10 unless you change it) in Video settings.',
      'Each frame gets its own 256-color palette.',
      'The sound is dropped, since GIF has none.',
    ],
    limits: [
      'Up to 900 frames: 90 seconds at 10 frames per second. Trim long videos first.',
      'GIF holds 256 colors per frame without dithering, so gradients can show banding.',
      'For sharing, MP4 or WebM is far smaller than a GIF of the same clip.',
    ],
    related: ['gif-to-mp4', 'webm-to-mp4', 'mov-to-mp4', 'mp4-to-mp3'],
    keywords: ['animated', 'animation', 'clip', 'meme', 'video'],
  },
  // ------------------------------------------------------------------ documents
  {
    slug: 'pdf-to-text', from: 'pdf', to: 'txt', category: 'document', common: 8,
    blurb: 'The text layer of a PDF',
    description: 'Extract the text of a PDF as a plain TXT file, page by page, with scanned pages flagged. Read by pdf.js in your browser; the PDF is never uploaded.',
    intro: 'Get the words out of a PDF to search, quote or reuse them. This is text extraction: the result is plain text, not a copy of the page layout.',
    details: [
      'pdf.js reads the PDF on your device and the text is rebuilt line by line from the positions on each page.',
      'Pages that have pictures but no text are reported as scans that need OCR, which FileConvert does not do.',
      'PDFs in Chinese, Japanese or Korean use character maps that download the first time they are needed.',
    ],
    limits: [
      'Columns, tables and page layout are not preserved; text comes out in reading order as well as it can be rebuilt.',
      'Password-protected PDFs cannot be read.',
      'PDFs up to 500 MB and 5,000 pages.',
    ],
    related: ['markdown-to-pdf', 'csv-to-json', 'json-to-csv'],
    keywords: ['txt', 'extract', 'text', 'document'],
  },
  {
    slug: 'markdown-to-pdf', from: 'md', to: 'pdf', category: 'document',
    blurb: 'Notes and READMEs as tidy PDFs',
    description: 'Turn Markdown files into clean PDFs with real, selectable text: headings, lists, tables, code and links. Rendered in your browser, never uploaded.',
    intro: 'Share notes, READMEs and documentation written in Markdown as a PDF anyone can open. This is a semantic conversion: the structure is kept, set in a clean default style.',
    details: [
      'Headings, emphasis, lists, tables, code blocks, block quotes, links and embedded PNG or JPEG pictures are kept.',
      'Text is set in Noto Sans and Noto Sans Mono, so it can be selected, searched and copied.',
      'US Letter or A4 pages, chosen in Documents settings.',
      'Inline HTML is cleaned first: scripts, forms, frames and event handlers are removed.',
    ],
    limits: [
      'Pictures from the web are not downloaded; they become their description.',
      'The fonts cover Latin, Greek and Cyrillic. Other scripts are reported and do not show.',
      'Files up to 8 MB.',
    ],
    related: ['pdf-to-text', 'json-to-csv'],
    keywords: ['md', 'readme', 'notes', 'document'],
  },
  // ------------------------------------------------------------------ data
  {
    slug: 'json-to-csv', from: 'json', to: 'csv', category: 'data', common: 9,
    blurb: 'Records as a spreadsheet table',
    description: 'Convert JSON arrays to CSV for Excel and Google Sheets, with nested objects as dotted columns and formula protection. Runs in your browser.',
    intro: 'A JSON list of records, such as an API response or an export, becomes a table: one row per record and one column per field.',
    details: [
      'Nested objects become dotted columns (address.city), and lists are kept as JSON text in one cell or spread into numbered columns.',
      'Choose comma, semicolon or tab as the separator, and add a byte order mark so Excel reads UTF-8 correctly.',
      'Text cells starting with = + - or @ get a leading apostrophe, so a spreadsheet cannot run them as formulas (you can turn this off).',
      'Large integers stay exact, even beyond what JavaScript numbers can hold.',
    ],
    limits: [
      'The top level should be an array of objects, or an object holding one.',
      'Files up to 200 MB, nested up to 500 levels.',
    ],
    related: ['csv-to-json', 'xlsx-to-csv', 'pdf-to-text'],
    keywords: ['spreadsheet', 'excel', 'table', 'api', 'export'],
  },
  {
    slug: 'csv-to-json', from: 'csv', to: 'json', category: 'data',
    blurb: 'Spreadsheet rows as JSON records',
    description: 'Convert CSV and TSV files to JSON, with the separator and text encoding detected and leading zeros kept. Private: converted on your device.',
    intro: 'Turn a spreadsheet export into JSON for code, APIs and configuration: each row becomes an object named by the header row.',
    details: [
      'Separators (comma, semicolon, tab, pipe) and encodings (UTF-8, UTF-16, Windows-1252) are detected and reported.',
      'Numbers and true or false are recognized if you want them to be, while codes with leading zeros, such as ZIP codes, stay text.',
      'Dotted column names (address.city) can rebuild nested objects.',
      'Without a header row, each row becomes a list instead.',
    ],
    limits: [
      'CSV has no types, so a digit string without leading zeros becomes a number when detection is on; turn it off to keep everything as text.',
      'Files up to 200 MB.',
    ],
    related: ['json-to-csv', 'xlsx-to-csv'],
    keywords: ['tsv', 'spreadsheet', 'excel', 'table', 'records'],
  },
  {
    slug: 'xlsx-to-csv', from: 'xlsx', to: 'csv', category: 'data',
    blurb: 'Excel sheets as plain CSV',
    description: 'Convert Excel XLSX worksheets to CSV: pick a sheet or get one CSV per sheet, with values as Excel shows them. Done in your browser.',
    intro: 'CSV is the plain-text table every database, script and app can import. FileConvert reads the workbook on your device and writes the sheet you choose.',
    details: [
      'Choose the first sheet, a named sheet, or all sheets as one CSV each.',
      'Values come out as Excel displays them (dates, percentages, currency) or as the underlying values, set in Data settings.',
      'Formulas give their saved results; cells starting with = + - or @ are protected from running as formulas.',
      'The package is checked for ZIP bombs before it is opened, and macros are never run.',
    ],
    limits: [
      'Formatting, charts, comments and formulas themselves are not part of a CSV.',
      'A formula saved without a result is noted.',
      'Workbooks up to 200 MB.',
    ],
    related: ['csv-to-json', 'json-to-csv'],
    keywords: ['excel', 'spreadsheet', 'workbook', 'sheet'],
  },
];

export function pageBySlug(slug: string): ConversionPage | undefined {
  return PAGES.find(p => p.slug === slug);
}

/** Pages in the Common conversions list, in order. */
export function commonPages(): ConversionPage[] {
  return PAGES.filter(p => p.common !== undefined).sort((a, b) => a.common! - b.common!);
}

export const CATEGORY_LABELS: Record<Category, string> = { image: 'Images', audio: 'Audio', video: 'Video', document: 'Documents', data: 'Data' };
