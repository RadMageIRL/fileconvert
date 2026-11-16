# FileConvert

**Convert your files. Keep your privacy. No accounts, no ads, no nonsense.**

FileConvert is a free file converter for images, audio, video, documents and data that runs entirely in your browser. Your files are never uploaded, to me or to anyone else: every conversion happens on your own device.

**Use it at [radmagelabs.com/fileconvert](https://radmagelabs.com/fileconvert/).**

Current version: **v0.1.1**

![FileConvert in the dark theme with a batch of six sample files converted: a HEIC photo to JPG, a FLAC file to MP3, a MOV clip to MP4, a CSV file to XLSX, a Markdown file to PDF and a JSON file to YAML, each with its download button](screenshots/fileconvert.png)

## What it converts

| From | To |
|---|---|
| **Images:** JPG, PNG, WebP, AVIF, HEIC/HEIF, BMP, GIF, TIFF | JPG, PNG, WebP, AVIF, GIF, BMP, TIFF |
| Animated GIF | Animated GIF, MP4, WebM |
| **Audio:** MP3, WAV, FLAC, AAC, M4A, OGG (Vorbis or Opus) | MP3, WAV, FLAC, AAC, M4A, OGG (Opus) |
| **Video:** MP4, WebM, MOV, MKV | MP4, WebM, MOV, MKV, GIF, or any audio format above (the soundtrack) |
| **Documents:** TXT | PDF |
| PDF | TXT |
| Markdown | HTML, PDF |
| HTML | PDF |
| DOCX | TXT |
| **Data:** JSON | CSV, YAML, XML |
| CSV | JSON, XLSX |
| YAML | JSON |
| XML | JSON |
| XLSX | CSV |

Every pair in this table is tested in the browser. Pictures, audio, video, PDFs and spreadsheets are checked by decoding the results with independent programs (Pillow, FFmpeg, Xpdf's pdftotext, openpyxl), not by looking at file extensions.

### What each kind of conversion does

- **Images:** quality for JPG, WebP and AVIF; resizing by percent or to fit inside a box (never enlarging); transparency kept where the output format can hold it and replaced by a background color you choose where it cannot (JPG, BMP), with a note saying so. EXIF orientation is applied to the pixels. An animated GIF stays animated when converted to GIF, MP4 or WebM.
- **Audio:** bitrate, sample rate and channels. Streams are copied without re-encoding when nothing asks for a change and the new container can hold them (an M4A to AAC, for example). Descriptive tags such as title and artist are kept.
- **Video:** resolution (2160p down to 360p, never enlarging), quality, and removing the sound. With quality set to Original, streams that fit the new container are copied, which is fast and lossless; MP4, MOV and MKV get H.264 video with AAC audio and WebM gets VP9 with Opus when re-encoding is needed. Video to GIF uses your choice of width and frame rate.
- **Documents:** PDFs are written with real, selectable text in Noto Sans and Noto Sans Mono. Plain text keeps its layout (monospaced, tabs expanded, long lines wrapped); Markdown and HTML keep their structure: headings, emphasis, lists, tables, code, block quotes, links and embedded PNG or JPEG pictures. PDF to TXT reads the text layer page by page. DOCX to TXT writes one line per paragraph, keeps line breaks, marks list items and puts table cells on one line separated by tabs.
- **Data:** nested JSON becomes dotted CSV columns (`address.city`), with lists kept as JSON text or spread into numbered columns; CSV can rebuild the nesting. CSV delimiters are detected, text encodings (UTF-8, UTF-16, Windows-1252) are detected and reported, numbers are recognized without breaking leading zeros such as ZIP codes, and integers beyond 2^53 stay exact. XLSX to CSV lets you pick a worksheet or get one CSV per sheet, with values as Excel displays them or the underlying values. XML attributes become `@` keys and element text `#text`, both ways.

Anything that is lost or changed on the way (transparency, animation frames, a color profile, a character the PDF font lacks, a formula without a saved result) is listed under the file in a short note. Nothing is dropped silently.

## Using it

1. Drop files on the page, or press **Choose files**. Add as many as you like.
2. Each file is identified by its contents, not its name, and gets a list of outputs that make sense for it. **Set all to** changes many files at once.
3. Open a settings panel if you want to change quality, size, bitrate, page size or data options.
4. Press **Convert** on a file, or **Convert all**. Conversions run in the background with real progress where it can be measured, and each can be canceled.
5. Download each result, or **Download all (ZIP)**. Results with the same name are numbered (`photo.png`, `photo (2).png`) so nothing overwrites anything.

Share copies the page's address, `https://radmagelabs.com/fileconvert/`, or opens your device's share sheet. **Back to RadMage Labs** goes to the rest of my tools.

## Privacy and security

- **Files stay on your device.** There is no server that receives files. Every conversion runs in this browser tab, in background workers, and the page's Content Security Policy only allows connections back to the site itself (to load the app's own code, fonts and codecs). It cannot send anything anywhere else.
- **No accounts, no ads, no analytics.**
- **What the network is used for:** loading the page, and the first time you use each kind of conversion, loading that converter (for example the HEIC decoder, or the PDF fonts). Once loaded, it keeps working offline while the tab stays open.
- **Temporary storage:** audio and video results are written to your browser's private storage for this site (the origin private file system) so large results do not have to fit in memory. They are deleted when you remove them from the list, clear the list, or close the tab; files left behind by a tab that crashed are deleted the next time the page opens. Other results are held in memory. Only your theme and settings are remembered between visits, in local storage.
- **Metadata is left behind.** Converted pictures carry no EXIF data (camera, date, GPS location). Audio and video keep descriptive tags such as title and artist, but not other container metadata, such as a phone's recording location.
- **Files are treated as untrusted.** Detection reads the bytes, not the name, and warns when the extension is wrong. Images are checked for decompression bombs (a tiny file claiming billions of pixels) before decoding. DOCX and XLSX packages are inflated as a stream and counted before any library unpacks them, so ZIP bombs are refused even when their directory lies. XML with entity declarations (XXE, billion laughs) is refused, YAML alias bombs are refused, and nesting depth is limited. Markdown and HTML are sanitized with DOMPurify before use: scripts, event handlers, forms, frames and `javascript:` links are removed, nothing in a document is fetched, and macros and embedded objects in DOCX files are never run.
- **Spreadsheet formulas:** CSV results protect text cells that start with `=`, `+`, `-` or `@` with a leading apostrophe, so opening them in a spreadsheet cannot run a formula (you can turn this off). CSV to XLSX stores such cells as text, never as formulas.
- **File names** are reduced to safe names before they are used for downloads or inside a ZIP: no paths, no characters Windows forbids, no reserved names and no text-direction tricks.

To report a security problem, open an [issue](https://github.com/RadMageIRL/fileconvert/issues) without the details and ask for a private channel.

## Browsers

| Browser | Status |
|---|---|
| Chrome 157 and Edge 157 (Windows) | Everything above. The full test suite passes. |
| Firefox 157 (Windows) | Everything above, except HEVC (H.265) video input, which Firefox cannot decode. The full test suite passes. |
| Chrome on a phone-sized screen | The interface and conversions tested at 412 pixels wide (Pixel 7 emulation) and at 360 pixels wide. |
| Safari | Not verified: I have not tested it on a Mac or an iPhone. |

Which audio and video codecs work depends on the browser and the computer, because the browser's own encoders and decoders do the work (often on the graphics chip). FileConvert checks before converting and says when something is not available, rather than failing halfway. Browsers without OffscreenCanvas or WebCodecs get a clear message for the conversions they cannot do; data and document conversions still work there.

## Known limitations

- **HEIC is read but not written.** The open HEVC encoders are GPL-licensed and patent-encumbered, and none is practical in a browser.
- **AVI is not supported yet**, for reading or writing.
- **DOCX to PDF and PDF to DOCX are not offered.** Page layout cannot be reproduced faithfully in a browser, and I would rather not offer a conversion that quietly rearranges a document.
- **Scanned PDFs need OCR** (optical character recognition), which FileConvert does not do. It says so when a PDF, or some of its pages, has no text layer.
- **Markdown and HTML to PDF** keep the document's structure in a clean default style. Stylesheets and page layout CSS are not applied, and pictures from the web are not downloaded (they become their description). Only PNG and JPEG pictures embedded in the file are included.
- **The PDF fonts cover Latin, Greek and Cyrillic.** Other scripts (Chinese, Japanese, Korean, Arabic, Hebrew, Hindi and others) are reported and do not show.
- **Animated WebP, APNG and animated AVIF** become their first frame, with a note. Animated GIF keeps its animation.
- **Color profiles:** the browser applies the color profile of the pictures it decodes (JPG, PNG, WebP, AVIF, GIF, BMP). HEIC and TIFF color profiles are not applied, so wide-gamut photos can look slightly less vivid.
- **GIF output** holds 256 colors per frame without dithering, so photos and gradients can show banding. Video to GIF is limited to 900 frames.
- **HDR video** that is re-encoded is not tone-mapped and can look washed out.
- **CSV has no types:** with number detection on, a digit string without leading zeros (such as `10001`) becomes a number; turn detection off to keep everything as text.
- **Size limits** keep the browser from running out of memory: pictures up to 100 megapixels and 300 MB, audio and video up to 8 GB, PDFs up to 500 MB, text to PDF up to 8 MB, data files up to 200 MB, and the batch ZIP up to about 4 GB.

## Development

FileConvert is a static site built with Vite and TypeScript. Conversions run in Web Workers; nothing needs a server.

Requirements: Node.js 24. The browser tests also use FFmpeg and Xpdf's `pdftotext` on the path, Python 3 with Pillow 11.3 or later, pillow-heif, NumPy and openpyxl (set `FILECONVERT_PYTHON` to that Python), Google Chrome, Microsoft Edge, and Playwright's Firefox and WebKit.

```
npm ci
npm run dev            # development server at http://localhost:5173/
npm run build          # type check and production build into dist/
npm test               # unit tests (Vitest)
npm run test:e2e       # browser tests against dist/: Chrome, Firefox, Edge, WebKit and a phone-sized Chrome
npm run test:large     # large files: a 48-megapixel photo, a 1 GB video, a 50 MB CSV
npm run notices        # rewrite THIRD-PARTY-NOTICES.txt after a dependency change
npm run release        # build twice, check the builds match, and pack release/ with SHA-256 sums
npm run fixtures       # regenerate the test files in tests/fixtures/
```

`node tools/serve.mjs` serves `dist/` at `http://127.0.0.1:4175/fileconvert/` with the same security headers radmagelabs.com sends; `--pages` serves it without headers, like GitHub Pages. Setting `FILECONVERT_BASE` (for example to `https://radmagelabs.com/fileconvert/`) runs the browser tests against a live copy instead. The test files in `tests/fixtures/` are synthetic (gradients, test patterns, sine tones and placeholder text) and are made by `tools/make-fixtures.py` and `tools/make-pdf-fixtures.mjs`.

The release download is the built site. Serve it from any web server (for example `python -m http.server` in its folder); browsers do not run module workers from pages opened as local files.

Layout:

- `src/core/`: the format registry, content sniffing, safe names, limits, text decoding, the ZIP check and temporary storage.
- `src/engines/`: one folder per kind of conversion (image, media, document, data).
- `src/workers/`: the Web Workers that run the engines.
- `src/app/`: the queue, the worker pools and the interface.
- `tests/unit/` and `tests/e2e/`: Vitest and Playwright tests.

## License

FileConvert is MIT licensed; see [LICENSE](LICENSE). It is built on open-source libraries, listed with their licenses in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt), which also ships with the app. Most are permissive; Mediabunny (MPL-2.0) and the LGPL codecs it and libheif-js include (LAME, FFmpeg's AAC encoder, libheif, libde265) are shipped as separate files, unmodified, with links to their source.
