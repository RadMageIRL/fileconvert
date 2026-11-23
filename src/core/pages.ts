// The dedicated pages: one per conversion or tool that has its own address, such as /fileconvert/heic-to-jpg/.
// This is the single list the page generator (src/site/render.ts), the catalog, the sitemap and the tests
// read. A conversion page names a pair from the format registry, and the build fails if that pair is not
// one FileConvert performs, so a page can never advertise a conversion that does not exist.
//
// The text is written per page and describes what the engines really do. Keep it accurate when an engine
// changes. It must stay plain ASCII (the house rules check source files).

import { FORMATS, type Category, type FormatId } from './formats.ts';
import type { ToolId } from './tools.ts';

interface PageText {
  slug: string;
  /** Where the page is listed in the catalog. */
  category: Category;
  /** Short line under the name in the catalog. */
  blurb: string;
  /** Meta description, 70 to 160 characters, unique. */
  description: string;
  /** The first paragraph under the heading. */
  intro: string;
  /** What happens to the file, specific to this page. */
  details: string[];
  /** Limits and things that change, specific to this page. */
  limits: string[];
  /** Slugs of related pages. */
  related: string[];
  /** Extra search words (synonyms, devices, apps). */
  keywords?: string[];
  /** Position in the Common conversions (or Tools) list on the home page. */
  common?: number;
}

/** A page for one conversion pair from the format registry. */
export interface ConversionPage extends PageText {
  kind?: 'convert';
  from: FormatId;
  to: FormatId;
}

/** A page for a tool that runs in the workspace. */
export interface ToolPage extends PageText {
  kind: 'tool';
  tool: ToolId;
  /** The tool's name, which is also the page heading: "Remove photo metadata". */
  name: string;
  /** The page title, at most 60 characters. */
  title: string;
  /** The three steps of the How to section. */
  steps: [string, string, string];
}

/**
 * A page for unpacking archives. It is the converter itself, whose Extract files step unpacks an archive, so the
 * archive code is the same here as on every other page; the page only explains its formats.
 */
export interface ExtractPage extends PageText {
  kind: 'extract';
  /** The archive formats the page is about. */
  formats: FormatId[];
  /** The page's name, which is also its heading: "Extract files from a ZIP". */
  name: string;
  /** The page title, at most 60 characters. */
  title: string;
  /** The three steps of the How to section. */
  steps: [string, string, string];
}

export type Page = ConversionPage | ToolPage | ExtractPage;

export const isTool = (p: Page): p is ToolPage => p.kind === 'tool';
export const isExtract = (p: Page): p is ExtractPage => p.kind === 'extract';
export const isConversion = (p: Page): p is ConversionPage => p.kind === undefined || p.kind === 'convert';
/** Tool and extraction pages have a name of their own rather than "A to B". */
export const isNamed = (p: Page): p is ToolPage | ExtractPage => isTool(p) || isExtract(p);

/** The page's display name, such as "HEIC to JPG" or "Remove photo metadata". */
export const pageName = (p: Page) => isNamed(p) ? p.name : `${FORMATS[p.from].label} to ${FORMATS[p.to].label}`;

/** The page title, at most 60 characters. */
export const pageTitle = (p: Page) => isNamed(p) ? p.title : `${pageName(p)} Converter, Free and Private | FileConvert`;

const PRIVATE_PHOTO = 'The photo is turned the right way up, and its EXIF details (camera, date, GPS location) are not copied into the result.';

export const PAGES: readonly Page[] = [
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
      'An animated WebP becomes its first frame, with a note; convert it to GIF, MP4 or WebM to keep the animation.',
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
      'An animated PNG (APNG) stays animated as an animated WebP.',
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
    slug: 'png-to-ico', from: 'png', to: 'ico', category: 'image', common: 10,
    blurb: 'Favicons and Windows icons',
    description: 'Make an ICO icon from a PNG: a favicon with 16, 32 and 48 pixel sizes, every size up to 256, or one size, with transparency kept. In your browser.',
    intro: 'ICO is the icon format of Windows and the classic website favicon. One ICO file holds the same picture at several sizes, and each place that shows it picks the size that fits.',
    details: [
      'The favicon preset holds 16, 32 and 48 pixel pictures. Choose all six sizes up to 256 pixels, or one size, in Images settings.',
      'Each size is a square picture stored as PNG inside the ICO, which keeps transparency and is read by Windows and every browser.',
      'A picture that is not square is fitted and centered on a transparent square, never stretched.',
      'Large pictures are reduced in steps, so the small sizes stay sharp.',
    ],
    limits: [
      'Sizes larger than your picture are enlarged and can look soft; start from at least 256 x 256 pixels for the full set.',
      'Windows XP and older read only bitmap icons, not PNG pictures inside an ICO.',
      'An animated PNG becomes its first frame.',
    ],
    related: ['png-to-jpg', 'png-to-webp', 'jpg-to-png', 'webp-to-png'],
    keywords: ['favicon', 'icon', 'windows', 'website', 'browser tab'],
  },
  {
    slug: 'svg-to-png', from: 'svg', to: 'png', category: 'image',
    blurb: 'Vector drawings as sharp pixels',
    description: 'Convert SVG drawings to PNG at any size, with transparency kept. The SVG is cleaned of scripts and outside links first and never uploaded.',
    intro: 'SVG drawings scale to any size, but many apps, documents and sites need a PNG. Choose the size, and the drawing is drawn sharp at exactly that size.',
    details: [
      'Choose its own size, twice or four times larger, or a width from 512 to 4096 pixels in Images settings; the height follows.',
      'Transparency is kept, so logos and icons stay cut out.',
      'Your browser draws the SVG, so gradients, filters, clipping and text look as they do in the browser.',
      'Before drawing, scripts, event handlers, HTML content and every link to a file, font or stylesheet outside the SVG are removed. Nothing in the file runs, and nothing is downloaded.',
    ],
    limits: [
      'Text uses the fonts installed on your device; fonts the SVG links to on the web are not downloaded.',
      'Animation is removed; the PNG shows the drawing before any animation.',
      'HTML inside an SVG (foreignObject) is removed, so text in it may be missing.',
    ],
    related: ['svg-to-jpg', 'png-to-ico', 'png-to-webp', 'png-to-jpg'],
    keywords: ['vector', 'logo', 'icon', 'drawing', 'illustration', 'transparent'],
  },
  {
    slug: 'svg-to-jpg', from: 'svg', to: 'jpg', category: 'image',
    blurb: 'Vector drawings for any app',
    description: 'Convert SVG drawings to JPG at the size you choose, with a background color for transparent areas. Cleaned and drawn in your browser, nothing uploaded.',
    intro: 'JPG is accepted almost everywhere, including places that refuse SVG. The drawing is drawn at the size you choose and saved as a JPG.',
    details: [
      'Choose its own size, twice or four times larger, or a width from 512 to 4096 pixels in Images settings.',
      'JPG has no transparency, so transparent areas are filled with the background color you choose (white unless you change it).',
      'JPG quality is 85 out of 100 unless you change it.',
      'Before drawing, scripts, event handlers, HTML content and every link outside the SVG are removed.',
    ],
    limits: [
      'For logos and line art, PNG keeps edges crisper and keeps transparency.',
      'Text uses the fonts installed on your device; fonts linked from the web are not downloaded.',
      'Animation is removed.',
    ],
    related: ['svg-to-png', 'png-to-jpg', 'webp-to-jpg'],
    keywords: ['vector', 'logo', 'drawing', 'illustration', 'jpeg'],
  },
  {
    kind: 'tool', slug: 'remove-image-metadata', tool: 'remove-image-metadata', category: 'image', common: 1,
    name: 'Remove photo metadata',
    title: 'Remove Photo Metadata (EXIF, GPS), Private | FileConvert',
    blurb: 'Camera details and location out, picture untouched',
    description: 'Remove EXIF, GPS location, XMP and other hidden data from JPG, PNG and WebP photos without recompressing them. Done on your device, nothing uploaded.',
    intro: 'Photos carry more than the picture: the camera and its serial number, when the photo was taken, often where, and what software edited it. This tool takes that out and leaves the picture exactly as it was.',
    steps: [
      'Add your photos. JPG, PNG and WebP, as many as you like; they are checked by their contents, not their names.',
      'Choose what to keep. Orientation and the color profile are kept unless you turn them off, so photos look the same.',
      'Remove and download. Each photo says what was removed and its size before and after; download them one by one or as a ZIP.',
    ],
    details: [
      'Removed: EXIF camera details and settings, dates, GPS location, maker notes, embedded thumbnails, XMP, IPTC and Photoshop data, comments, PNG text fields, and extra data after the picture such as a motion photo video.',
      'The compressed picture is copied byte for byte. Nothing is decoded or re-encoded, so the quality is exactly the same.',
      'A sideways photo keeps a minimal EXIF block holding only its orientation, so it still shows upright. Turn that off to remove EXIF completely.',
      'The color profile (ICC) is kept so colors look the same; it describes colors, not you. Turn it off to remove it too.',
      'Transparency, animation and color settings that a PNG or WebP needs to show correctly are kept.',
    ],
    limits: [
      'The picture itself is not changed: faces, landmarks, documents or screens in the photo can still identify a person or a place.',
      'HEIC, AVIF and TIFF are not supported by this tool; converting them to JPG or PNG removes their metadata.',
      'Photos up to 300 MB each, up to 500 at a time.',
    ],
    related: ['heic-to-jpg', 'png-to-jpg', 'webp-to-jpg'],
    keywords: ['exif', 'gps', 'location', 'privacy', 'strip', 'metadata', 'remove', 'clean', 'photo', 'iphone'],
  },
  {
    kind: 'tool', slug: 'images-to-tiff', tool: 'images-to-tiff', category: 'image', common: 2,
    name: 'Combine images into a TIFF',
    title: 'Combine Images into One Multi-Page TIFF | FileConvert',
    blurb: 'Many pictures, one multi-page TIFF',
    description: 'Combine JPG, PNG, HEIC and other pictures into one multi-page TIFF, in the order you choose, uncompressed or LZW. Runs in your browser.',
    intro: 'Scans, receipts and page photos are often wanted as one file. A multi-page TIFF keeps every page lossless, and document systems, fax software and image viewers open it.',
    steps: [
      'Add your pictures. JPG, PNG, WebP, AVIF, HEIC, BMP, GIF, ICO, and TIFF files, whose pages are all added.',
      'Put them in order. Drag the rows, or use Up and Down; the first file becomes page 1.',
      'Make the TIFF. Choose no compression or LZW, then download the TIFF.',
    ],
    details: [
      'Each picture becomes one page at its own size, turned upright first.',
      'Pages are stored losslessly: uncompressed, or LZW, which is smaller and read by Windows, macOS and Office.',
      'Transparency is kept on the pages that have it.',
      'A multi-page TIFF among your files adds all of its pages, in their order.',
    ],
    limits: [
      'Up to 1,000 pages and 400 megapixels in all.',
      'An animated GIF or WebP gives its first frame as the page.',
      'HEIC and TIFF color profiles are not applied.',
    ],
    related: ['png-to-ico', 'remove-image-metadata', 'heic-to-jpg'],
    keywords: ['tiff', 'tif', 'multipage', 'multi-page', 'combine', 'merge', 'scan', 'fax', 'pages'],
  },
  {
    slug: 'gif-to-webp', from: 'gif', to: 'webp', category: 'image',
    blurb: 'Animated GIFs as animated WebP',
    description: 'Convert animated GIFs to animated WebP, keeping every frame, its timing and the loop, often in a much smaller file. Converted in your browser.',
    intro: 'Animated WebP plays everywhere a GIF does in current browsers, with full color and real transparency, and is usually much smaller than the same animation as a GIF.',
    details: [
      'Every frame is composited the way GIF viewers show it, with the GIF disposal rules, then encoded as WebP.',
      'Each frame keeps its own timing, and the loop setting (forever, or a number of plays) is kept.',
      'Transparency is kept. Quality is 85 out of 100 unless you change it in Images settings; resizing applies to every frame.',
      'A still GIF becomes a still WebP.',
    ],
    limits: [
      'GIF delays of 10 ms or less are shown as 20 ms, close to how browsers play them.',
      'Each frame is stored whole, so an animation where little changes can be larger than an optimized WebP.',
      'GIFs up to 5,000 frames.',
    ],
    related: ['webp-to-gif', 'gif-to-mp4', 'mp4-to-gif'],
    keywords: ['animated', 'animation', 'gif', 'smaller', 'web'],
  },
  {
    slug: 'webp-to-gif', from: 'webp', to: 'gif', category: 'image',
    blurb: 'Animated WebP for apps that need GIF',
    description: 'Convert animated WebP to an animated GIF with every frame and its timing, for chat apps and tools that only take GIF. Done in your browser.',
    intro: 'Some chat apps, editors and older tools still only accept GIF. The WebP animation is read frame by frame and written as an animated GIF.',
    details: [
      'Your browser reads every frame (ImageDecoder), composited as the WebP shows it.',
      'Each frame keeps its timing, and the loop setting is kept.',
      'Each frame gets its own 256-color palette.',
      'A still WebP becomes a still GIF.',
    ],
    limits: [
      'GIF holds 256 colors per frame without dithering, so gradients can show banding.',
      'GIF transparency is on or off: partly transparent pixels become fully opaque or fully transparent, with a note.',
      'Needs ImageDecoder, which current Chrome, Edge and Firefox have; elsewhere only the first frame converts.',
    ],
    related: ['gif-to-webp', 'webp-to-png', 'mp4-to-gif'],
    keywords: ['animated', 'animation', 'sticker', 'chat'],
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
  {
    slug: 'aiff-to-mp3', from: 'aiff', to: 'mp3', category: 'audio',
    blurb: 'Mac and studio audio as MP3',
    description: 'Convert AIFF and AIFF-C audio from a Mac, GarageBand or a recorder to MP3 at the bitrate you choose. Read on your device and never uploaded.',
    intro: 'AIFF is Apple\'s uncompressed audio format, used by Logic, GarageBand and many recorders. MP3 makes it a fraction of the size and plays everywhere.',
    details: [
      'AIFF and AIFF-C are read directly: 8, 16, 24 and 32-bit samples, little-endian (sowt), 32 and 64-bit float, mu-law and A-law.',
      'Encoded with LAME (WebAssembly) at an automatic high-quality bitrate unless you choose 96 to 320 kbit/s in Audio settings.',
      'Long recordings are read in pieces, never loaded whole, and the result goes to your browser\'s private storage.',
      'For a lossless copy, convert to FLAC or WAV instead: 16-bit AIFF comes out sample for sample.',
    ],
    limits: [
      'Compressed AIFF-C (IMA ADPCM, MACE and others) is not supported, and FileConvert names the codec.',
      'WAV results are 16-bit, so 24-bit and float recordings are rounded to 16 bits there.',
      'Files up to 8 GB.',
    ],
    related: ['wav-to-mp3', 'flac-to-mp3', 'm4a-to-mp3'],
    keywords: ['aif', 'aifc', 'apple', 'mac', 'garageband', 'logic', 'audio', 'studio'],
  },
  // ------------------------------------------------------------------ video
  {
    slug: 'ts-to-mp4', from: 'ts', to: 'mp4', category: 'video',
    blurb: 'Camcorder and recorder streams as MP4',
    description: 'Convert MPEG-TS video (.ts, .mts, .m2ts) with H.264 to MP4, copied without re-encoding where possible. Converted in your browser, never uploaded.',
    intro: 'MPEG transport streams come from camcorders, screen and game recorders, live streams and TV tuners. MP4 holds the same H.264 video and plays in every player and editor.',
    details: [
      'H.264 video with AAC sound is copied into the MP4 without re-encoding when Quality is Original: fast, with every frame kept.',
      'The stream table at the start of the file is read, so anything that cannot be converted is named rather than left out silently.',
      'Resolution and quality can be set in Video settings, and the sound can be removed.',
      'MPEG audio (MP2), as TV recordings carry, converts to any audio format.',
    ],
    limits: [
      'MPEG-2 video, used by TV recordings and DVDs, cannot be decoded in a browser; only its sound converts, and FileConvert says so.',
      'AC-3 sound converts in Edge; in other browsers the picture converts without sound, with a note first.',
      'Sound that AVCHD camcorders store in a private stream cannot be read; the picture still converts, with a note.',
      'Files up to 8 GB.',
    ],
    related: ['mkv-to-mp4', 'mov-to-mp4', 'mp4-to-mp3'],
    keywords: ['mts', 'm2ts', 'camcorder', 'avchd', 'stream', 'recording', 'tv', 'transport'],
  },
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
      'Every PDF is checked before it is read: compressed data that would expand far beyond the file, oversized pictures and other ways to make a reader use gigabytes of memory are refused within a second or two.',
      'PDFs in Chinese, Japanese or Korean use character maps that download the first time they are needed.',
    ],
    limits: [
      'Columns, tables and page layout are not preserved; text comes out in reading order as well as it can be rebuilt.',
      'Encrypted PDFs are not opened, including ones that open without a password but restrict copying or printing. FileConvert never removes a PDF\'s protection.',
      'PDFs up to 500 MB and 5,000 pages.',
    ],
    related: ['merge-pdf', 'markdown-to-pdf', 'csv-to-json'],
    keywords: ['txt', 'extract', 'text', 'document'],
  },
  {
    kind: 'tool', slug: 'merge-pdf', tool: 'merge-pdf', category: 'document', common: 4,
    name: 'Merge PDFs',
    title: 'Merge PDF Files, Private and Free | FileConvert',
    blurb: 'Several PDFs as one, links and bookmarks kept',
    description: 'Merge PDF files into one in the order you choose, keeping links, bookmarks and form fields. Done in your browser; your PDFs are never uploaded.',
    intro: 'Put reports, scans, forms and chapters together as one PDF. Every page is copied as it is, so it looks exactly as it did, and its links, bookmarks and form fields come along.',
    steps: [
      'Add your PDFs. Each is checked as it is added: its pages, whether it is digitally signed, and whether it is safe to open.',
      'Put them in order. Drag the rows, or use Up and Down; the first file comes first.',
      'Merge and download. The result lists what was kept, what was renamed and what was left out.',
    ],
    details: [
      'Pages are copied as they are, not redrawn: text stays selectable and pictures keep their quality.',
      'Bookmarks: one for each file, named after it, with the file\'s own bookmarks under it.',
      'Links between pages, named destinations and annotations are kept, and point at the right pages of the merged PDF.',
      'Form fields keep their values. A field whose name an earlier file already uses is renamed, such as name_2 in the second file, so each keeps its own value.',
      'Layers keep their settings: a hidden layer stays hidden.',
      'The first file\'s title, author and other document information are kept.',
    ],
    limits: [
      'Not kept: accessibility tags, page labels such as i, ii, iii, files attached to the document, document scripts, article threads and XFA form data. The result lists what each file loses.',
      'Merging changes a digitally signed PDF, so its signature is no longer valid. FileConvert asks before merging one.',
      'Encrypted PDFs are not opened, including ones that open without a password but restrict copying or printing.',
      'Up to 200 files, 5,000 pages and 1 GB together, and less on a device with little memory: merging can need about three times the files\' size in memory.',
    ],
    related: ['split-pdf', 'pdf-to-text', 'organize-pdf'],
    keywords: ['combine', 'join', 'append', 'pdf', 'bookmarks', 'forms', 'document', 'pages'],
  },
  {
    kind: 'tool', slug: 'split-pdf', tool: 'split-pdf', category: 'document', common: 5,
    name: 'Split a PDF',
    title: 'Split a PDF into Pages or Ranges, Private | FileConvert',
    blurb: 'One PDF as several, by ranges or pages',
    description: 'Split a PDF by page ranges, every few pages, or into single pages, with bookmarks and links kept where their pages go. Runs in your browser.',
    intro: 'Send only the chapter that matters, or break a long scan into parts. Each new PDF holds its own pages exactly as they were, and nothing of the others.',
    steps: [
      'Add your PDF. It is checked as it is added: its pages, whether it is digitally signed, and whether it is safe to open.',
      'Choose how to split it: page ranges such as 1-3, 4-7, 8-, every few pages, or one file per page.',
      'Split and download each file, or all of them as a ZIP. Names say which pages each holds, such as report-p04-07.pdf.',
    ],
    details: [
      'Pages are copied as they are, not redrawn, so each one looks exactly as it did.',
      'Each file keeps the bookmarks, links, named destinations and form fields of its own pages; what pointed only at pages in other files is removed, and the result says how much.',
      'Ranges may overlap: each file gets its own copy of the pages. Pages in no range are left out.',
      'Nothing of the other pages is in a file: their text, pictures, notes and field values are not copied at all.',
    ],
    limits: [
      'Not kept in the new files: accessibility tags, page labels, files attached to the document, document scripts, article threads and XFA form data. The result lists what was left out.',
      'Splitting a digitally signed PDF makes the signature invalid. FileConvert asks first.',
      'Encrypted PDFs are not opened, including ones that open without a password but restrict copying or printing.',
      'PDFs up to 500 MB and 5,000 pages.',
    ],
    related: ['extract-pdf-pages', 'merge-pdf', 'delete-pdf-pages'],
    keywords: ['split', 'separate', 'divide', 'break', 'pages', 'ranges', 'pdf', 'document'],
  },
  {
    kind: 'tool', slug: 'extract-pdf-pages', tool: 'extract-pdf-pages', category: 'document', common: 6,
    name: 'Extract pages from a PDF',
    title: 'Extract Pages from a PDF, Private and Free | FileConvert',
    blurb: 'Chosen pages as a new PDF',
    description: 'Extract the pages you choose from a PDF into a new one, in the order you list them, with their links and bookmarks. Done on your device.',
    intro: 'Take a signed page, a single invoice or a few slides out of a long PDF. The pages you list become a new PDF in that order, and the rest leave nothing behind.',
    steps: [
      'Add your PDF. Its pages are counted as it is added.',
      'List the pages, such as 1-3, 7, 10-. They come out in the order you write them, each once.',
      'Extract and download the new PDF.',
    ],
    details: [
      'Pages are copied as they are, not redrawn, so each one looks exactly as it did.',
      'Bookmarks, links, named destinations and form fields of the pages taken are kept; what pointed only at other pages is removed.',
      'Nothing of the other pages is in the new PDF: their text, pictures, notes and field values are not copied at all.',
    ],
    limits: [
      'Not kept: accessibility tags, page labels, files attached to the document, document scripts, article threads and XFA form data. The result lists what was left out.',
      'Extracting from a digitally signed PDF makes the signature invalid. FileConvert asks first.',
      'Encrypted PDFs are not opened, including ones that open without a password but restrict copying or printing.',
      'PDFs up to 500 MB and 5,000 pages.',
    ],
    related: ['split-pdf', 'delete-pdf-pages', 'merge-pdf'],
    keywords: ['extract', 'select', 'pick', 'save pages', 'pages', 'pdf', 'document'],
  },
  {
    kind: 'tool', slug: 'delete-pdf-pages', tool: 'delete-pdf-pages', category: 'document', common: 7,
    name: 'Delete pages from a PDF',
    title: 'Delete Pages from a PDF, Private and Free | FileConvert',
    blurb: 'Pages out, nothing of them left behind',
    description: 'Delete pages from a PDF and leave nothing of them in the file: no hidden text, pictures or old copies. Done in your browser; nothing is uploaded.',
    intro: 'Remove blank pages, a cover sheet or pages that should not be shared. Many tools only hide removed pages; here their content, pictures and everything that pointed only at them leave the file.',
    steps: [
      'Add your PDF. Its pages are counted as it is added.',
      'List the pages to delete, such as 2, 5-6. At least one page has to stay.',
      'Delete and download. The result lists what went with the pages.',
    ],
    details: [
      'The pages that stay are kept exactly as they were, and look exactly the same.',
      'The deleted pages\' text, pictures, notes and field values are removed from the file, along with links, bookmarks and named destinations that went only to them; the result says how many.',
      'Older copies of pages that a PDF keeps from earlier edits are removed too: the file is written whole.',
    ],
    limits: [
      'This removes pages; it is not redaction. The pages that stay, the document information and any attachments are not searched or changed.',
      'Accessibility tags and article threads are removed when pages are, since they hold the removed pages\' text; page labels are removed too.',
      'Deleting pages from a digitally signed PDF makes the signature invalid. FileConvert asks first.',
      'Encrypted PDFs are not opened. PDFs up to 500 MB and 5,000 pages.',
    ],
    related: ['extract-pdf-pages', 'split-pdf', 'organize-pdf'],
    keywords: ['delete', 'remove', 'drop', 'pages', 'blank pages', 'pdf', 'document'],
  },
  {
    kind: 'tool', slug: 'organize-pdf', tool: 'organize-pdf', category: 'document', common: 8,
    name: 'Reorder PDF pages',
    title: 'Reorder PDF Pages, Private and Free | FileConvert',
    blurb: 'Pages in a new order, links still right',
    description: 'Reorder the pages of a PDF by dragging, with Up and Down, or by typing the order. Links and bookmarks follow their pages. Done in your browser.',
    intro: 'Fix a scan that came out of order or move an appendix to the end. Every page stays as it is; only the order changes, and links and bookmarks still lead to the right pages.',
    steps: [
      'Add your PDF. Its pages are listed in order.',
      'Move the pages: drag them, use Up and Down, or type the order, such as 3, 1, 2, 4-10.',
      'Reorder and download the PDF.',
    ],
    details: [
      'Every page and everything on it is kept; only the order changes.',
      'Links, bookmarks and named destinations keep pointing at the same pages, wherever those pages now are.',
      'The keyboard works throughout, and the typed order is the same list without dragging.',
    ],
    limits: [
      'Page labels such as i, ii, iii are removed when pages move, since they would no longer match.',
      'Reordering a digitally signed PDF makes the signature invalid. FileConvert asks first.',
      'Encrypted PDFs are not opened. PDFs up to 500 MB and 5,000 pages.',
    ],
    related: ['rotate-pdf', 'delete-pdf-pages', 'merge-pdf'],
    keywords: ['reorder', 'organize', 'arrange', 'sort', 'move pages', 'rearrange', 'pdf', 'document'],
  },
  {
    kind: 'tool', slug: 'rotate-pdf', tool: 'rotate-pdf', category: 'document', common: 9,
    name: 'Rotate PDF pages',
    title: 'Rotate PDF Pages, Private and Free | FileConvert',
    blurb: 'Pages turned upright, nothing redrawn',
    description: 'Rotate every page of a PDF, or only the ones you choose, clockwise, counterclockwise or upside down. Nothing is redrawn or uploaded.',
    intro: 'Turn sideways scans upright or fix a page that came out upside down. Only each page\'s rotation changes, so its text, pictures, links and form fields turn with it.',
    steps: [
      'Add your PDF. Its pages are counted as it is added.',
      'Choose the turn, and the pages: leave the list empty for every page, or write pages such as 1, 3-5.',
      'Rotate and download the PDF.',
    ],
    details: [
      'Nothing on the page is redrawn or recompressed: the PDF records the new rotation and every reader turns the whole page.',
      'A turn adds to the rotation a page already has, so a page that was sideways can be turned back.',
      'Links, notes and form fields turn with their pages and keep working.',
    ],
    limits: [
      'Rotating a digitally signed PDF makes the signature invalid. FileConvert asks first.',
      'Encrypted PDFs are not opened. PDFs up to 500 MB and 5,000 pages.',
    ],
    related: ['organize-pdf', 'split-pdf', 'merge-pdf'],
    keywords: ['rotate', 'turn', 'flip', 'upright', 'sideways', 'landscape', 'portrait', 'pdf', 'document'],
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
    related: ['pdf-to-text', 'markdown-to-docx', 'json-to-csv'],
    keywords: ['md', 'readme', 'notes', 'document'],
  },
  {
    slug: 'markdown-to-docx', from: 'md', to: 'docx', category: 'document',
    blurb: 'Markdown as an editable Word document',
    description: 'Turn Markdown into a Word DOCX document with real headings, lists, tables, links, code and pictures, in Word\'s own styles. Converted in your browser.',
    intro: 'Share notes, READMEs or a draft written in Markdown with people who work in Word. The result is an ordinary document, ready to edit and restyle.',
    details: [
      'Headings use Word\'s Heading 1 to 6 styles, so the navigation pane and a table of contents work, and lists are real Word lists, nested as in the Markdown.',
      'Bold, italic, strikethrough, links, tables with a header row and their column alignment, block quotes, subscript and superscript are kept.',
      'Code is set in Consolas, in Code Block and Inline Code styles you can change in Word.',
      'PNG, JPEG, GIF and BMP pictures inside the Markdown are included, scaled to fit the page. Pages are US Letter or A4, chosen in Documents settings.',
    ],
    limits: [
      'Pictures from the web are never downloaded: they become their description, as do WebP and SVG pictures.',
      'Inline HTML is cleaned first: scripts, forms and frames are removed.',
      'Task list boxes ([ ] and [x]) stay as text.',
      'Files up to 8 MB.',
    ],
    related: ['docx-to-markdown', 'html-to-docx', 'docx-to-html'],
    keywords: ['md', 'word', 'doc', 'readme', 'notes', 'pandoc'],
  },
  {
    slug: 'docx-to-markdown', from: 'docx', to: 'md', category: 'document',
    blurb: 'Word documents as Markdown',
    description: 'Convert Word DOCX documents to GitHub-flavored Markdown with headings, nested lists, tables, links, code and pictures. Converted on your device.',
    intro: 'Move a Word document into a README, a wiki, a static site or a notes app. The text and its structure come across as Markdown that is easy to edit.',
    details: [
      'Mammoth reads the document on your device. Headings, bold, italic, strikethrough, links, nested bullet and numbered lists, block quotes, code blocks and footnotes become their Markdown forms.',
      'Tables become GitHub-flavored Markdown tables; several paragraphs in a cell are joined with line breaks, and a | in a cell is escaped.',
      'Pictures are kept inside the Markdown as data URLs, so the file stands alone. Documents settings can instead put them in separate files, in a ZIP with the Markdown and an assets folder whose links work in a GitHub repository, or replace each by its description.',
      'Text in a code font such as Consolas or Courier New becomes code, and Word, LibreOffice and pandoc code styles become code blocks.',
    ],
    limits: [
      'Underline, fonts, colors, alignment, page layout, headers and footers, comments and tracked changes are not part of Markdown.',
      'Merged table cells are split, since Markdown tables cannot merge cells, and numbered lists start at 1.',
      'Some Markdown viewers, such as GitHub, do not show pictures kept as data URLs; choose separate files for those.',
      'Documents up to 200 MB, with up to 100 MB of pictures.',
    ],
    related: ['docx-to-html', 'markdown-to-docx', 'html-to-markdown'],
    keywords: ['word', 'doc', 'md', 'readme', 'wiki', 'notes', 'obsidian', 'gfm'],
  },
  {
    slug: 'docx-to-html', from: 'docx', to: 'html', category: 'document',
    blurb: 'Word documents as web pages',
    description: 'Convert Word DOCX documents to clean, standalone HTML with headings, lists, tables, links and pictures kept. Runs in your browser; nothing is uploaded.',
    intro: 'Publish a Word document on the web or in an email as one HTML file. The structure of the document is kept, in a clean style that reads well on phones.',
    details: [
      'Mammoth reads the document on your device: headings, paragraphs, bold, italic, underline, strikethrough, subscript and superscript, lists to nine levels, tables with merged cells, links and footnotes.',
      'Pictures stored in the document are kept inside the HTML file, so it stands alone.',
      'Word, LibreOffice and pandoc quote and code styles become quotes and code blocks, and text set in a code font such as Consolas becomes code.',
      'The page runs no scripts and loads nothing from the web: its own security policy allows only the pictures inside it.',
    ],
    limits: [
      'This keeps the structure, not the look: fonts, colors, sizes, alignment, page layout, headers and footers, comments and tracked changes are not kept.',
      'Pictures that are only linked from the document are not fetched, and EMF or WMF drawings are kept but browsers cannot show them.',
      'Numbered lists start at 1, whatever number the document started them at.',
      'Documents up to 200 MB, with up to 100 MB of pictures.',
    ],
    related: ['docx-to-markdown', 'markdown-to-docx', 'html-to-markdown'],
    keywords: ['word', 'doc', 'web', 'page', 'publish', 'email'],
  },
  {
    slug: 'html-to-markdown', from: 'html', to: 'md', category: 'document',
    blurb: 'Web pages as clean Markdown',
    description: 'Convert HTML pages and fragments to GitHub-flavored Markdown with headings, lists, links, tables and code kept and scripts removed. In your browser.',
    intro: 'Markdown is how notes, READMEs and wikis are written. FileConvert turns an HTML file into Markdown on your device, keeping the structure and dropping what is not content.',
    details: [
      'Headings, paragraphs, bold, italic, strikethrough, inline code, links, pictures, nested lists, block quotes and horizontal rules become their Markdown forms.',
      'Tables become GitHub-flavored Markdown tables with their column alignment, and a | in a cell is escaped. Tables that hold lists or code stay as HTML, which Markdown allows.',
      'Code blocks are fenced, with their language when the HTML names it (class="language-python").',
      'Scripts, styles, forms, frames and event handlers are removed first, and pictures from the web stay as their address: nothing is downloaded.',
    ],
    limits: [
      'The whole page body is converted, menus and footers included; delete what you do not need.',
      'Layout, colors and fonts are not part of Markdown. Subscript and superscript stay as HTML tags.',
      'Pictures inside the HTML as data URLs stay inside the Markdown, unless Documents settings choose separate files (a ZIP with the Markdown and an assets folder) or Description only.',
      'Files up to 8 MB.',
    ],
    related: ['docx-to-markdown', 'html-to-docx', 'markdown-to-docx'],
    keywords: ['md', 'web', 'page', 'htm', 'readme', 'notes', 'gfm', 'github'],
  },
  {
    slug: 'html-to-docx', from: 'html', to: 'docx', category: 'document',
    blurb: 'Web pages as editable Word documents',
    description: 'Convert HTML pages to Word DOCX documents with headings, lists, tables, links, code and pictures in Word\'s own styles. Scripts removed, in your browser.',
    intro: 'Turn a saved web page, an HTML export or a report into a Word document you can edit, comment on and send. FileConvert cleans the page and writes the document on your device.',
    details: [
      'Headings use Word\'s Heading 1 to 6 styles, so the navigation pane and a table of contents work. Lists are real Word lists, nested as in the page and starting at the same number.',
      'Tables keep their header row and their merged cells, and a table inside a cell stays inside it. Links keep their address, and links within the page jump to the heading they name.',
      'Bold, italic, underline, strikethrough, highlighting, subscript, superscript, block quotes and code blocks are kept, with code in Code Block and Inline Code styles you can change in Word.',
      'PNG, JPEG, GIF and BMP pictures inside the HTML file are included, scaled to fit the page. Pages are US Letter or A4, chosen in Documents settings.',
    ],
    limits: [
      'This keeps the structure, not the look: the page\'s fonts, colors, sizes, alignment and layout are not applied.',
      'Pictures from the web or a relative address are never downloaded: they become their description, as do WebP, AVIF and SVG pictures.',
      'Scripts, forms, frames, videos and event handlers are removed first. The whole page body is converted, menus and footers included.',
      'Files up to 8 MB.',
    ],
    related: ['html-to-markdown', 'markdown-to-docx', 'docx-to-html'],
    keywords: ['htm', 'web', 'page', 'word', 'doc', 'report', 'export'],
  },
  // ------------------------------------------------------------------ data
  {
    slug: 'json-to-csv', from: 'json', to: 'csv', category: 'data', common: 9,
    blurb: 'Records as a spreadsheet table',
    description: 'Convert JSON arrays to CSV for Excel and Google Sheets, with nested objects as dotted columns and formula protection. Runs in your browser.',
    intro: 'A JSON list of records, such as an API response or an export, becomes a table: one row per record and one column per field.',
    details: [
      'Nested objects become dotted columns (address.city), and lists are kept as JSON text in one cell or spread into numbered columns.',
      'An object holding a list of records beside other fields gives one row per record, with those fields repeated on every row. Two lists of records give two CSV files, never a mix of both.',
      'Choose comma, semicolon or tab as the separator, and add a byte order mark so Excel reads UTF-8 correctly.',
      'Text cells starting with = + - or @ get a leading apostrophe, so a spreadsheet cannot run them as formulas (you can turn this off).',
      'Large integers stay exact, even beyond what JavaScript numbers can hold.',
    ],
    limits: [
      'Rows come from the top level: a list of records inside a record, such as an order\'s lines, stays in its row as JSON text or numbered columns, and the notes say so.',
      'null and a missing field are both empty cells. A key repeated inside one object keeps its last value, as in every JSON reader, with a note.',
      'Files up to 200 MB, nested up to 500 levels.',
    ],
    related: ['csv-to-json', 'json-to-xlsx', 'xlsx-to-csv'],
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
    related: ['xlsx-to-json', 'csv-to-json', 'json-to-csv'],
    keywords: ['excel', 'spreadsheet', 'workbook', 'sheet'],
  },
  {
    slug: 'xlsx-to-json', from: 'xlsx', to: 'json', category: 'data',
    blurb: 'Excel sheets as typed JSON',
    description: 'Convert Excel XLSX sheets to JSON with numbers, true/false and empty cells kept as JSON types and dates as ISO 8601 text. Done in your browser.',
    intro: 'Turn a spreadsheet into JSON for code, APIs and configuration: each row becomes an object named by the header row, with real numbers and booleans rather than text.',
    details: [
      'Numbers keep the exact value Excel stores, TRUE and FALSE become true and false, and empty cells become null.',
      'Cells formatted as dates become ISO 8601 text (2026-11-22, with the time when there is one). Excel dates have no time zone, so none is added.',
      'Choose the first sheet, a named sheet, or all sheets in one JSON object keyed by sheet name.',
      'Dotted headings (address.city) can rebuild nested objects, set in Data settings. Without a header row, each row becomes a list.',
      'Emoji and other characters are kept exactly, including in workbooks written by Python tools such as pandas.',
    ],
    limits: [
      'Formulas give their saved results; a formula saved without a result becomes null, with a note.',
      'Formatting, charts and comments are not part of JSON, and merged cells keep their value in the first cell.',
      'Workbooks up to 200 MB.',
    ],
    related: ['json-to-xlsx', 'xlsx-to-csv', 'csv-to-json', 'json-to-csv'],
    keywords: ['excel', 'spreadsheet', 'workbook', 'sheet', 'api'],
  },
  {
    slug: 'json-to-xlsx', from: 'json', to: 'xlsx', category: 'data',
    blurb: 'Records as an Excel workbook',
    description: 'Convert JSON arrays to Excel XLSX workbooks with typed number and true/false cells, one sheet per list, and text that never runs as a formula.',
    intro: 'A JSON list of records becomes a worksheet you can sort, filter and share: one row per record and one column per field.',
    details: [
      'Numbers and true/false become typed cells. Text, including dates written as text, stays text.',
      'Nested objects become dotted columns (address.city); lists stay JSON text in one cell or spread into numbered columns, set in Data settings.',
      'An object whose values are all lists becomes one sheet per list, named after its key. A list of records beside other fields gives one row per record, with those fields repeated.',
      'Text that starts with = is stored as text, so opening the workbook can never run it as a formula.',
    ],
    limits: [
      'Integers larger than Excel can hold exactly are stored as text, so no digit is lost.',
      'Records with different fields share one column per field; a missing field is an empty cell. Lists of records inside a record stay in their row.',
      'Up to 1,048,576 rows and 16,384 columns per sheet, the Excel limits.',
    ],
    related: ['xlsx-to-json', 'json-to-csv', 'csv-to-json'],
    keywords: ['excel', 'spreadsheet', 'workbook', 'table', 'api', 'export'],
  },
  {
    slug: 'xls-to-xlsx', from: 'xls', to: 'xlsx', category: 'data',
    blurb: 'Old Excel workbooks as XLSX',
    description: 'Convert Excel 97-2003 XLS workbooks to XLSX, keeping every sheet, value, formula and date format. Converted in your browser; nothing is uploaded.',
    intro: 'XLS is the Excel format from before 2007. Newer apps, Google Sheets imports and many tools want XLSX. FileConvert rewrites the workbook on your device.',
    details: [
      'Every sheet is converted, with its values, formulas and their saved results, number formats (so dates stay dates), merged cells, column widths and hidden sheets.',
      'The file is checked before it is read, and macros are never read or run.',
      'TRUE and FALSE values that LibreOffice stored as formulas become plain values.',
      'A note lists what was kept and what was not.',
    ],
    limits: [
      'Fonts, colors, borders and other cell formatting, charts, pictures, comments and macros are not kept. Check the result in Excel before replacing the original.',
      'Password-protected workbooks cannot be read.',
      'Workbooks up to 200 MB.',
    ],
    related: ['xls-to-csv', 'ods-to-xlsx', 'xlsx-to-csv'],
    keywords: ['excel', '97', '2003', 'upgrade', 'workbook', 'spreadsheet', 'biff'],
  },
  {
    slug: 'xls-to-csv', from: 'xls', to: 'csv', category: 'data',
    blurb: 'Excel 97-2003 sheets as CSV',
    description: 'Convert XLS worksheets from Excel 97-2003 to CSV: one sheet or all of them, dates as Excel shows them, numbers in full. Done in your browser.',
    intro: 'Get the data out of an old Excel workbook for a database, a script or another app. The workbook is read on your device and each sheet becomes plain CSV.',
    details: [
      'Choose the first sheet, a named sheet, or every sheet as a CSV of its own.',
      'Values come out as Excel shows them (dates, percentages, currency) or as the stored values, set in Data settings. Numbers in the General format keep the 15 digits Excel stores.',
      'Formulas give their saved results, and cells starting with = + - or @ are protected from running as formulas.',
      'Text in any language, emoji included, is kept, and the CSV is UTF-8.',
    ],
    limits: [
      'Formatting, charts, comments and the formulas themselves are not part of a CSV.',
      'Password-protected workbooks cannot be read, and macros are never run.',
      'Workbooks up to 200 MB.',
    ],
    related: ['xls-to-xlsx', 'xlsx-to-csv', 'ods-to-csv'],
    keywords: ['excel', '97', '2003', 'spreadsheet', 'sheet', 'export'],
  },
  {
    slug: 'ods-to-xlsx', from: 'ods', to: 'xlsx', category: 'data',
    blurb: 'LibreOffice spreadsheets as Excel files',
    description: 'Convert OpenDocument ODS spreadsheets from LibreOffice and OpenOffice to Excel XLSX with sheets, values, formulas and dates kept. Runs in your browser.',
    intro: 'ODS is the spreadsheet format of LibreOffice and OpenOffice. When someone needs an Excel file, FileConvert rewrites the workbook as XLSX on your device.',
    details: [
      'Every sheet is converted, with values, formulas and their saved results, number formats (so dates stay dates) and merged cells.',
      'Formulas are written the way Excel writes them, such as SUM(B2:B3).',
      'The package is checked for ZIP bombs before it is opened, and macros are never run.',
      'A note lists what was kept and what was not.',
    ],
    limits: [
      'Cell formatting, column widths, which sheets are hidden, charts, pictures, comments and macros are not kept. Check the result in Excel.',
      'Password-protected files cannot be read.',
      'Spreadsheets up to 200 MB.',
    ],
    related: ['ods-to-csv', 'xls-to-xlsx', 'xlsx-to-csv'],
    keywords: ['libreoffice', 'openoffice', 'calc', 'opendocument', 'excel', 'spreadsheet'],
  },
  {
    slug: 'ods-to-csv', from: 'ods', to: 'csv', category: 'data',
    blurb: 'OpenDocument sheets as CSV',
    description: 'Convert ODS spreadsheets from LibreOffice, OpenOffice or a Google Sheets export to CSV, one sheet or all of them, in your browser. Nothing is uploaded.',
    intro: 'Turn an OpenDocument spreadsheet into plain CSV that any database, script or app can import, without opening LibreOffice.',
    details: [
      'Choose the first sheet, a named sheet, or every sheet as a CSV of its own.',
      'Values come out as the spreadsheet shows them or as the stored values, set in Data settings.',
      'Formulas give their saved results, and cells starting with = + - or @ are protected from running as formulas.',
      'The package is checked for ZIP bombs before it is opened.',
    ],
    limits: [
      'Formatting, charts and the formulas themselves are not part of a CSV.',
      'Which sheets are hidden is not read from ODS files, so with All sheets a hidden sheet is converted like the others.',
      'Spreadsheets up to 200 MB.',
    ],
    related: ['ods-to-xlsx', 'xls-to-csv', 'csv-to-json'],
    keywords: ['libreoffice', 'openoffice', 'calc', 'opendocument', 'google', 'sheets', 'spreadsheet'],
  },
  {
    slug: 'jsonl-to-csv', from: 'jsonl', to: 'csv', category: 'data',
    blurb: 'NDJSON logs and exports as a table',
    description: 'Convert JSON Lines (JSONL, NDJSON) to CSV: one row per line, nested fields as dotted columns, and a bad line named, not skipped. In your browser.',
    intro: 'JSON Lines holds one JSON record per line, as logs, data exports and machine learning datasets do. FileConvert turns it into a CSV table for a spreadsheet.',
    details: [
      'Each line is one row. Nested objects become dotted columns (user.name), and lists stay JSON text in one cell or spread into numbered columns.',
      'Records with different fields share one column per field, in the order the fields first appear.',
      'Large integers keep every digit, and cells starting with = + - or @ are protected from running as formulas.',
      'Blank lines are skipped and counted, and Windows and Unix line endings both work.',
    ],
    limits: [
      'Reading is strict: a line that is not a complete JSON value stops the conversion and is named, so no record is ever dropped without you knowing.',
      'Files up to 200 MB and 10 million lines.',
    ],
    related: ['json-to-jsonl', 'json-to-csv', 'csv-to-json'],
    keywords: ['ndjson', 'lines', 'jsonlines', 'logs', 'dataset', 'export', 'spreadsheet'],
  },
  {
    slug: 'json-to-jsonl', from: 'json', to: 'jsonl', category: 'data',
    blurb: 'A JSON array as one record per line',
    description: 'Convert a JSON array to JSON Lines (JSONL, NDJSON), one compact record per line, ready for datasets, logs and bulk imports. Converted in your browser.',
    intro: 'Many tools take JSON Lines rather than one big JSON array: dataset uploads, log pipelines and database bulk imports. FileConvert writes one record per line.',
    details: [
      'Each item of the top-level list becomes one line of compact JSON; an object holding a single list uses that list.',
      'Every value keeps its type, and integers beyond what JavaScript numbers hold keep all their digits.',
      'Line breaks inside text are escaped, so each record stays on one line. Lines end with LF, the last one too.',
      'CSV, TSV and spreadsheets convert to JSON Lines as well, one row per line.',
    ],
    limits: [
      'JSON that is not a list becomes a single line, with a note.',
      'Files up to 200 MB, nested up to 500 levels.',
    ],
    related: ['jsonl-to-csv', 'json-to-csv', 'csv-to-json'],
    keywords: ['ndjson', 'lines', 'jsonlines', 'dataset', 'training', 'bulk', 'import'],
  },
  {
    slug: 'xml-to-csv', from: 'xml', to: 'csv', category: 'data',
    blurb: 'Repeated XML records as a table',
    description: 'Convert XML to CSV: each repeated element becomes a row, attributes and child elements become columns, and nothing beside them is dropped. In your browser.',
    intro: 'XML exports, feeds and catalogs repeat the same element for every record. FileConvert finds those records and writes them as a CSV table.',
    details: [
      'The records are the elements that repeat, such as every <book> in a catalog, and wrapper elements around them are stepped into. Several repeated elements give one CSV each.',
      'Attributes and child elements are columns by name, deeper elements are dotted columns (address.city), and an element with attributes and text gives price and price.currency.',
      'What sits beside the records, such as a <meta> block or an attribute of the catalog, is repeated on every row, so nothing is lost.',
      'Entity tricks (XXE, billion laughs) are refused, and nothing the XML refers to is loaded.',
    ],
    limits: [
      'An element repeated inside one record is one cell holding a JSON list, or numbered columns, as set in Data settings.',
      'XML that repeats no element becomes a single row.',
      'Files up to 200 MB, nested up to 500 levels.',
    ],
    related: ['xml-to-xlsx', 'json-to-csv', 'yaml-to-csv'],
    keywords: ['feed', 'rss', 'export', 'records', 'table', 'spreadsheet'],
  },
  {
    slug: 'xml-to-xlsx', from: 'xml', to: 'xlsx', category: 'data',
    blurb: 'XML records as an Excel workbook',
    description: 'Convert XML to Excel XLSX: repeated elements become rows on their own sheets, with numbers as numbers and leading zeros kept. Done in your browser.',
    intro: 'Open an XML export in Excel as a proper table you can sort and filter. Each kind of repeated record gets a sheet of its own.',
    details: [
      'The records are the elements that repeat, and each repeated element gets a sheet named after it.',
      'Attributes and child elements become columns, and what sits beside the records is repeated on every row.',
      'Plain numbers become number cells, while codes with leading zeros, dates and long digit strings stay text. Turn number detection off in Data settings to keep every cell as text.',
      'Text that starts with = is stored as text, so the workbook can never run it as a formula.',
    ],
    limits: [
      'An element repeated inside one record is one cell holding a JSON list, or numbered columns.',
      'Up to 1,048,576 rows and 16,384 columns per sheet, the Excel limits.',
    ],
    related: ['xml-to-csv', 'json-to-xlsx', 'xlsx-to-json'],
    keywords: ['excel', 'spreadsheet', 'workbook', 'feed', 'export', 'records'],
  },
  {
    slug: 'yaml-to-csv', from: 'yaml', to: 'csv', category: 'data',
    blurb: 'YAML lists as a spreadsheet table',
    description: 'Convert YAML to CSV: a list of records becomes rows, nested keys become dotted columns, and unsafe tags are never run. Converted in your browser.',
    intro: 'YAML holds configuration, inventories and data files. When it is a list of records, FileConvert lays it out as a CSV table for a spreadsheet.',
    details: [
      'A list becomes one row per item. A mapping that holds a list of records uses that list, with its other keys repeated on every row so nothing is lost. Two lists of records give two CSV files, never a mix of both.',
      'Several documents in one file are one row each, or one table of all their items when each document is a list.',
      'Anchors, aliases and merge keys are resolved, and dates stay text, as YAML 1.2 reads them.',
      'Cells starting with = + - or @ are protected from running as formulas.',
    ],
    limits: [
      'Custom tags such as !!python/object are never run: their values stay plain data, with a note.',
      'Aliases that would expand far beyond the file (a billion laughs) and nesting deeper than 500 levels are refused.',
      'Files up to 200 MB.',
    ],
    related: ['json-to-csv', 'xml-to-csv', 'csv-to-json'],
    keywords: ['yml', 'config', 'inventory', 'table', 'spreadsheet', 'kubernetes'],
  },
  // ------------------------------------------------------------------ archives
  {
    kind: 'extract', slug: 'extract-zip', formats: ['zip'], category: 'archive', common: 3,
    name: 'Extract files from a ZIP',
    title: 'Extract ZIP Files Online, Free and Private | FileConvert',
    blurb: 'Open a ZIP, then download or convert what is inside',
    description: 'Unzip ZIP archives in your browser: download each file inside, or convert the photos, documents and data in it, without uploading anything.',
    intro: 'A ZIP file holds other files, compressed. FileConvert opens it on your device, lists everything inside with its kind and size, and lets you download each file or convert it straight away, with no second upload.',
    steps: [
      'Add your ZIP file. Drop it on this page or press Choose files.',
      'Press Extract files. Every file inside is listed with what it is and its size; files in folders show their path.',
      'Download or convert. Download a file on its own, or tick files and add them to the list to convert them, for example HEIC photos to JPG.',
    ],
    details: [
      'The archive is read in pieces, so large ZIP files, ZIP64 ones over 4 GB included, are unpacked without loading the whole file into memory.',
      'Each file is checked against the CRC-32 checksum stored with it as it is unpacked.',
      'Each file inside is recognized by its contents, so the list shows which ones FileConvert can convert.',
      'Unpacked files stay in this browser tab, in its private storage when the browser has one, and are deleted when you remove the archive from the list.',
    ],
    limits: [
      'Encrypted (password-protected) files, links and unusual compression methods are listed with the reason and not unpacked.',
      'A ZIP inside the ZIP is listed as a file: add it to the list to unpack it in turn. Nothing is unpacked automatically.',
      'Up to 10,000 files and 4 GB unpacked. A file that unpacks to more than 1,000 times its packed size, past the first 64 MB, is stopped as a likely ZIP bomb.',
      'FileConvert does not make ZIP files, apart from downloading several results together, and does not turn a ZIP into another archive format.',
    ],
    related: ['extract-tar', 'heic-to-jpg', 'xlsx-to-csv'],
    keywords: ['unzip', 'extract', 'open', 'decompress', 'archive', 'uncompress', 'zipfile'],
  },
  {
    kind: 'extract', slug: 'extract-tar', formats: ['tar', 'gz'], category: 'archive',
    name: 'Extract TAR, TAR.GZ and GZ files',
    title: 'Extract TAR, TAR.GZ and TGZ Files Online | FileConvert',
    blurb: 'Unpack .tar, .tar.gz, .tgz and .gz files',
    description: 'Unpack TAR, TAR.GZ, TGZ and GZ files in your browser on Windows, a Mac or a phone, then download or convert the files inside. Nothing is uploaded.',
    intro: 'TAR archives, usually compressed with gzip as .tar.gz or .tgz, are how software, backups and data sets are shared on Linux and macOS. Windows and phones often cannot open them; this page can, on your device.',
    steps: [
      'Add your .tar, .tar.gz, .tgz or .gz file. Drop it on this page or press Choose files.',
      'Press Extract files. A gzipped TAR is decompressed and unpacked in one step, and a single .gz file, such as data.csv.gz, gives back its one file.',
      'Download or convert. Download each file, or tick files and add them to the list to convert them.',
    ],
    details: [
      'Long names and paths in the POSIX (PAX) and GNU formats are read, and so are old TAR files without the ustar mark.',
      'A .gz file that holds a TAR is recognized by its contents, whatever its name.',
      'The archive is read in pieces, so large archives do not need to fit in memory.',
      'Files in folders show their path. Empty folders and file permissions are not recreated, since a download has neither.',
    ],
    limits: [
      'Symbolic and hard links, devices and other special entries are listed with the reason and not followed.',
      'Only gzip compression: .tar.bz2, .tar.xz and .tar.zst are not supported.',
      'Up to 10,000 files and 4 GB unpacked, with the same ZIP bomb check as ZIP files.',
    ],
    related: ['extract-zip', 'jsonl-to-csv', 'csv-to-json'],
    keywords: ['tgz', 'gzip', 'targz', 'untar', 'gunzip', 'extract', 'decompress', 'linux', 'backup', 'archive'],
  },
];

export function pageBySlug(slug: string): Page | undefined {
  return PAGES.find(p => p.slug === slug);
}

/** Pages in the Common conversions list, in order. */
export function commonPages(): Page[] {
  return PAGES.filter(p => p.common !== undefined).sort((a, b) => a.common! - b.common!);
}

export const CATEGORY_LABELS: Record<Category, string> = { image: 'Images', audio: 'Audio', video: 'Video', document: 'Documents', data: 'Data', archive: 'Archives' };
