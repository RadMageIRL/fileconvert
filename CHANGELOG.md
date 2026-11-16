# Changelog

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
