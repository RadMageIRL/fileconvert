# Changelog

## Unreleased

Work toward v0.2.0.

- **Pages for common conversions.** HEIC to JPG, MP4 to MP3, JSON to CSV and 19 more have their own page, such as `/fileconvert/heic-to-jpg/`, with the converter at the top (it chooses that output for every file you add), what happens to your files, what to expect, and related conversions. The text is in the page itself, so it reads without scripts.
- **Find a conversion.** Search every page as you type and filter by category. Asking for a conversion without its own page (BMP to TIFF) says whether FileConvert does it; asking for a format it does not support (AVI) says why.
- **Common conversions** are listed under the drop zone on the home page.
- The promise is now "Convert files. Upload nothing."
- The layout works on screens 320 pixels wide.
- A tab left open while FileConvert is updated, which then asks for a converter the new version no longer has, now says to reload the page instead of blaming memory.
- **Excel to JSON and JSON to Excel.** JSON from a workbook keeps numbers, true/false and empty cells as JSON values and writes dates as ISO 8601 text; pick one sheet or get all of them in one file. JSON to Excel gives typed cells, one sheet per list, text that can never run as a formula, and every digit of large integers. New pages: Excel to JSON and JSON to Excel.
- **TSV is its own format**, read and written, to and from CSV, JSON and Excel, with the same formula protection as CSV. Converted files say how many cells protection changed, and it can be turned off.
- **SVG to PNG, JPG, WebP and the other picture formats**, drawn at its own size, two or four times larger, or a width up to 4096 pixels. Every SVG is cleaned first: scripts, event handlers, HTML content, animation and every link to a file, font or stylesheet outside the SVG are removed, entity declarations are refused, and nothing in the file runs or is downloaded. New pages: SVG to PNG and SVG to JPG.
- **Remove photo metadata**, a new privacy tool with its own page. It takes EXIF camera details, dates, GPS location, maker notes, embedded thumbnails, XMP, IPTC and Photoshop data, comments, PNG text fields and extra data after the picture (such as a motion photo's video) out of JPG, PNG and WebP photos, without recompressing them: the picture data is copied byte for byte. Orientation (as a minimal EXIF block holding nothing else) and the color profile are kept unless you turn them off. Each photo says what was removed and kept and its size before and after; batches download as a ZIP.
- Tools have their own pages, listed under Tools on the home page, and run in a shared workspace with ordering, options, progress, cancel and ZIP downloads.
- **Combine images into a TIFF**, a new tool: pictures in the order you set become the pages of one multi-page TIFF, each turned upright, uncompressed or LZW; a multi-page TIFF among them adds all its pages.
- **ICO in and out.** Icons from any picture: a favicon with 16, 32 and 48 pixel sizes, all six sizes up to 256, or one size, each kept transparent. ICO and CUR files are read too, whether their pictures are PNG or 32-bit, 8-bit or 1-bit bitmaps with a transparency mask. New page: PNG to ICO.
- **Multi-page TIFF.** Every page of a multi-page TIFF converts (one file per page, or one TIFF keeping them all in order), or only the first page if you choose. TIFF can be written with LZW compression, which is lossless and read by Windows, macOS and Office.
- Emoji and other characters beyond the Basic Multilingual Plane are kept in workbooks written by Python tools such as pandas; they used to become a different character on the way to CSV.
- Mediabunny and its encoders are updated to 1.66.2.

## v0.1.2 - 2026-11-16

- The link preview image now has a text description (og:image:alt), for screen readers and link previews that show it.

## v0.1.1 - 2026-11-16

Visual style cleanup.

- The privacy notes now open from a Privacy pill in the footer, as in the other RadMage Labs tools, instead of filling the bottom of the page. The text is unchanged.

## v0.1.0 - 2026-11-15

The first release.

### Conversions

- **Images:** JPG, PNG, WebP, AVIF, HEIC/HEIF, BMP, GIF and TIFF to JPG, PNG, WebP, AVIF, GIF, BMP and TIFF, with quality, resizing (by percent or to fit a box), transparency kept or replaced by a chosen color, and EXIF orientation applied. Animated GIF to animated GIF, MP4 or WebM.
- **Audio:** MP3, WAV, FLAC, AAC, M4A and OGG to MP3, WAV, FLAC, AAC, M4A and OGG (Opus), with bitrate, sample rate and channels, and the soundtrack of any supported video.
- **Video:** MP4, WebM, MOV and MKV to MP4, WebM, MOV, MKV and GIF, with resolution, quality and removing the sound. Streams are copied without re-encoding when the new container can hold them.
- **Documents:** TXT to PDF, PDF to TXT, Markdown to HTML and PDF, HTML to PDF, and DOCX to TXT.
- **Data:** JSON to CSV, YAML and XML; CSV to JSON and XLSX; YAML to JSON; XML to JSON; XLSX to CSV.

### Interface

- Drag and drop or a file picker, many files at once, format detection from file contents with a note when the name is wrong, outputs offered per file, Set all to, per-category settings, a queue with real progress, cancel, Convert all, single downloads and a batch ZIP, numbered names when results share a name.
- Dark and light themes, keyboard use throughout, a layout that works from 360 pixels wide, Share, and Back to RadMage Labs.

### Privacy and security

- Every conversion runs in the browser; nothing is uploaded, and the Content Security Policy allows connections only to the site itself.
- Content-based detection, decompression bomb checks for images and ZIP-based documents, refusal of XML entity declarations and YAML alias bombs, nesting limits, HTML sanitizing, spreadsheet formula protection in CSV, safe file names, and size limits that keep the browser from running out of memory.
- Pictures lose their EXIF metadata. Audio and video keep descriptive tags but not raw container metadata.
