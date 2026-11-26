// Writes THIRD-PARTY-NOTICES.txt from what the build actually ships.
//   npm run notices    (builds once to collect the package list, then writes the file)
// Every npm package whose code or files end up in dist/ is listed with its version, license and the full
// license text it ships. Components compiled into other files (pdfmake's prebuilt bundle, the native
// libraries inside the WebAssembly codecs) are listed with license texts kept in tools/licenses/.
// The production build fails when the package list here no longer matches the bundles.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIC = join(root, 'tools', 'licenses');
const listFile = join(root, 'node_modules', '.fileconvert-packages.json');

execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, FILECONVERT_PACKAGES_OUT: listFile },
});
const bundled = JSON.parse(readFileSync(listFile, 'utf8'));

/** What each package does in FileConvert. Packages pulled in by another are described as part of it. */
const USE = {
  mediabunny: 'Reading and writing MP4, MOV, MKV, WebM, MP3, WAV, FLAC, AAC and Ogg (media worker)',
  '@mediabunny/mp3-encoder': 'MP3 encoding with LAME (media worker)',
  '@mediabunny/aac-encoder': 'AAC encoding with FFmpeg\'s AAC encoder where the browser has none (media worker)',
  '@mediabunny/flac-encoder': 'FLAC encoding with libFLAC (media worker)',
  '@jsquash/avif': 'AVIF encoding, and AVIF decoding where the browser has none (image worker)',
  '@jsquash/webp': 'WebP encoding where the browser has none, and Compress WebP and Resize images: WebP decoding and encoding (image worker)',
  '@jsquash/jpeg': 'MozJPEG: JPEG decoding and encoding for Compress JPG and Resize images (image worker, loaded only by those tools)',
  '@jsquash/oxipng': 'oxipng: lossless PNG recompression for Compress PNG (image worker, loaded only by that tool)',
  'libheif-js': 'HEIC and HEIF decoding (image worker)',
  utif: 'TIFF reading and writing (image worker)',
  gifenc: 'GIF writing (image and media workers)',
  'gifuct-js': 'Animated GIF reading (image and media workers)',
  'js-binary-schema-parser': 'Part of gifuct-js',
  'pdfjs-dist': 'Reading text from PDFs, and drawing PDF pages as pictures (PDF to JPG and PNG, page previews), with its character maps, standard fonts, JPEG 2000 and JBIG2 decoders, color management module and CMYK color profile',
  pdfmake: 'Writing PDFs (document worker)',
  'html-to-pdfmake': 'Turning Markdown and HTML into PDF layout (page)',
  'markdown-it': 'Markdown rendering (page)',
  'linkify-it': 'Part of markdown-it', mdurl: 'Part of markdown-it', 'uc.micro': 'Part of markdown-it', 'punycode.js': 'Part of markdown-it', entities: 'Part of markdown-it',
  dompurify: 'Sanitizing HTML (page)',
  mammoth: 'Reading DOCX documents (document worker)',
  docx: 'Writing DOCX documents from Markdown, with its HTML reader docx/html (document worker)',
  turndown: 'Writing Markdown from HTML and DOCX (page)',
  '@joplin/turndown-plugin-gfm': 'GitHub-flavored Markdown tables and strikethrough for turndown (page)',
  jszip: 'Part of mammoth (licensed under MIT, chosen from MIT OR GPL-3.0-or-later)',
  pako: 'Part of jszip', '@xmldom/xmldom': 'Part of mammoth', lop: 'Part of mammoth', option: 'Part of mammoth', underscore: 'Part of mammoth',
  'dingbat-to-unicode': 'Part of mammoth', 'base64-js': 'Part of mammoth', xmlbuilder: 'Part of mammoth',
  papaparse: 'CSV parsing (data worker)',
  yaml: 'YAML reading and writing (data worker)',
  'fast-xml-parser': 'XML reading and writing (data worker)',
  'fast-xml-builder': 'Part of fast-xml-parser', strnum: 'Part of fast-xml-parser', 'path-expression-matcher': 'Part of fast-xml-parser',
  '@nodable/entities': 'Part of fast-xml-parser', anynum: 'Part of fast-xml-parser', 'is-unsafe': 'Part of fast-xml-parser', 'xml-naming': 'Part of fast-xml-parser',
  xlsx: 'Reading XLSX, XLS and ODS workbooks and writing XLSX (SheetJS Community Edition, data worker)',
  fflate: 'ZIP reading checks, the batch ZIP, and measuring compressed PDF data in the PDF guard',
  '@cantoo/pdf-lib': 'Editing PDFs: reading, rewriting pages and writing the result (PDF worker, loaded only when a PDF is edited)',
  culori: 'Part of @cantoo/pdf-lib', 'html-entities': 'Part of @cantoo/pdf-lib', 'node-html-better-parser': 'Part of @cantoo/pdf-lib', tslib: 'Part of @cantoo/pdf-lib',
  '@expo-google-fonts/noto-sans': 'Noto Sans font files embedded in generated PDFs (the fonts are SIL OFL 1.1)',
  '@expo-google-fonts/noto-sans-mono': 'Noto Sans Mono font files embedded in generated PDFs (the fonts are SIL OFL 1.1)',
};

/** Code inside a package that keeps its own license: [what, license file in the package]. */
const VENDORED = {
  'pdfjs-dist': [
    ['the Foxit standard fonts (Courier, Times, Symbol and Dingbats replacements), from PDFium, in standard_fonts', 'standard_fonts/LICENSE_FOXIT'],
    ['OpenJPEG (JPEG 2000 decoding, openjpeg.wasm)', 'wasm/LICENSE_OPENJPEG'],
    ['pdf.js OpenJPEG decoder build', 'wasm/LICENSE_PDFJS_OPENJPEG'],
    ['the JBIG2 decoder from PDFium (jbig2.wasm)', 'wasm/LICENSE_JBIG2'],
    ['pdf.js JBIG2 decoder build', 'wasm/LICENSE_PDFJS_JBIG2'],
    ['qcms (color management, qcms_bg.wasm)', 'wasm/LICENSE_QCMS'],
    ['pdf.js qcms build', 'wasm/LICENSE_PDFJS_QCMS'],
    ['the CMYK color profile CGATS001Compat-v2-micro.icc, in iccs', 'iccs/LICENSE'],
  ],
  '@jsquash/jpeg': [
    ['the MozJPEG (libjpeg-turbo) license roll-up, for mozjpeg_enc.wasm and mozjpeg_dec.wasm', 'codec/LICENSE.codec.md'],
  ],
  '@jsquash/oxipng': [
    ['the oxipng license, for squoosh_oxipng_bg.wasm', 'codec/LICENSE.codec.md'],
  ],
  '@cantoo/pdf-lib': [
    ['UPNG, PNG decoding (Photopea), vendored in packages/upng', 'src/packages/upng/LICENSE'],
    ['@pdf-lib/standard-fonts, the 14 standard font metrics (Andrew Dillon), vendored in packages/standard-fonts', 'src/packages/standard-fonts/LICENSE.md'],
  ],
};

const unknown = bundled.filter(n => !USE[n]);
const gone = Object.keys(USE).filter(n => !bundled.includes(n));
if (unknown.length || gone.length) {
  console.error(`The bundled packages changed. Describe ${unknown.join(', ') || '(none)'} and remove ${gone.join(', ') || '(none)'} in tools/third-party-notices.mjs.`);
  process.exit(1);
}

const pkgDir = n => join(root, 'node_modules', ...n.split('/'));
const pkgJson = n => JSON.parse(readFileSync(join(pkgDir(n), 'package.json'), 'utf8'));
const text = f => readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
const licenseFiles = n => {
  const dir = pkgDir(n);
  const names = readdirSync(dir).filter(f => /^(licen[sc]e|copying)(\.|$)/i.test(f)).sort();
  // Font packages: the font license first, then the package's own.
  if (n.startsWith('@expo-google-fonts/')) names.sort((a, b) => Number(/FONT/.test(b)) - Number(/FONT/.test(a)));
  return names.map(f => join(dir, f));
};
const repoUrl = p => {
  const r = typeof p.repository === 'string' ? p.repository : p.repository?.url;
  return (r || p.homepage || `https://www.npmjs.com/package/${p.name}`).replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:/, 'https:').replace(/^github:/, 'https://github.com/');
};

const rule = '='.repeat(78);
const NL = String.fromCharCode(10);
const thin = '-'.repeat(78);
const out = [];
out.push(`FileConvert: third-party notices

FileConvert's own code is licensed under the MIT License (see LICENSE.txt).

FileConvert is built with the open-source components below, unmodified. Each keeps
its own license; the full texts follow. All of them are permissive (MIT, ISC,
BSD, Apache-2.0, IJG, zlib, SIL OFL 1.1, BlueOak) except these, which are weak copyleft:

  - Mediabunny and its MP3, AAC and FLAC encoder packages, and DOMPurify (offered
    as MPL-2.0 OR Apache-2.0): Mozilla Public License 2.0. Their source code is
    available at the addresses listed for them below.
  - libheif and libde265, inside libheif-js: GNU LGPL 3.0.
  - LAME, inside @mediabunny/mp3-encoder: GNU LGPL 2.0 or later.
  - FFmpeg's AAC encoder, inside @mediabunny/aac-encoder: GNU LGPL 2.1 or later.

The LGPL libraries are compiled to WebAssembly and shipped as separate files that
FileConvert loads at run time, so they can be replaced with modified builds. Their
complete source code is available at the addresses listed for them below.

This file is generated by tools/third-party-notices.mjs from the files the build
actually ships.

Bundled packages: ${bundled.map(n => `${n}@${pkgJson(n).version}`).join(', ')}


1. npm packages in the build
${rule}
`);

for (const n of bundled) {
  const p = pkgJson(n);
  const lic = typeof p.license === 'string' ? p.license : p.license?.type ?? 'see below';
  out.push(`${n} ${p.version}`);
  out.push(`License: ${lic}`);
  out.push(`Source: ${repoUrl(p)}`);
  out.push(`Used for: ${USE[n]}`);
  const files = licenseFiles(n);
  if (!files.length) out.push('\n(The package ships no license file; its package.json declares the license above.)');
  for (const f of files) out.push(`\n${text(f)}`);
  // Code a package carries inside itself under its own license (@cantoo/pdf-lib: UPNG and the standard font metrics).
  for (const [what, file] of VENDORED[n] ?? []) out.push(`\n--- ${n}: ${what} (${file}) ---\n\n${text(join(pkgDir(n), file))}`);
  // Native libraries shipped by Mediabunny's encoder packages.
  const extra = join(pkgDir(n), 'licenses');
  if (existsSync(extra)) {
    for (const lib of readdirSync(extra).sort()) {
      for (const f of readdirSync(join(extra, lib)).sort()) out.push(`\n--- ${n}: licenses/${lib}/${f} ---\n\n${text(join(extra, lib, f))}`);
    }
  }
  out.push(`\n${thin}\n`);
}

out.push(`
2. Components inside prebuilt files
${rule}

pdfmake's browser build (pdfmake/build/pdfmake.js) is distributed with these
modules compiled into it. Those installed alongside it are listed with their
own license files; the rest with the license files of their published packages.
`);
const inside = ['pdfkit', 'fontkit', 'linebreak', 'xmldoc', 'sax', 'restructure', 'brotli', 'dfa', 'png-js', 'clone', 'tiny-inflate', 'unicode-properties', 'unicode-trie', 'fast-deep-equal', '@noble/ciphers', '@noble/hashes', '@swc/helpers', 'base64-js', 'fflate'];
for (const n of inside) {
  const p = pkgJson(n);
  const lic = typeof p.license === 'string' ? p.license : 'MIT';
  out.push(`${n} ${p.version} (${lic}, ${repoUrl(p)})`);
  const files = licenseFiles(n);
  for (const f of files) out.push(`\n${text(f)}`);
  if (!files.length) out.push('\n(The package ships no license file; its package.json declares the license above.)');
  out.push(`\n${thin}\n`);
}
const fetched = [
  ['core-js', 'MIT', 'https://github.com/zloirock/core-js', 'npm-core-js-LICENSE.txt'],
  ['buffer', 'MIT', 'https://github.com/feross/buffer', 'npm-buffer-LICENSE.txt'],
  ['ieee754', 'BSD-3-Clause', 'https://github.com/feross/ieee754', 'npm-ieee754-LICENSE.txt'],
  ['events', 'MIT', 'https://github.com/browserify/events', 'npm-events-LICENSE.txt'],
  ['file-saver', 'MIT', 'https://github.com/eligrey/FileSaver.js', 'npm-file-saver-LICENSE.txt'],
];
for (const [n, lic, url, f] of fetched) out.push(`${n} (${lic}, ${url})\n\n${text(join(LIC, f))}\n\n${thin}\n`);

out.push(`
3. Native libraries compiled to WebAssembly
${rule}

libheif (LGPL-3.0, https://github.com/strukturag/libheif) and libde265
(LGPL-3.0, https://github.com/strukturag/libde265), built by libheif-emscripten
1.23.5 (https://github.com/catdad-experiments/libheif-emscripten) and shipped in
libheif-js. Their license texts are under libheif-js in section 1.

LAME 3.100 (LGPL-2.0-or-later, https://lame.sourceforge.io/), FFmpeg's AAC
encoder (LGPL-2.1-or-later, https://ffmpeg.org/) and libFLAC (Xiph.Org BSD-style,
https://github.com/xiph/flac), built by Mediabunny's encoder packages. Their
license texts are under those packages in section 1. LAME asks for credit and a
link: https://lame.sourceforge.io/

libavif 1.0.1 and libaom 3.7.0 (AVIF encoding and decoding), libsharpyuv and
libwebp (WebP encoding and decoding) and libyuv, built by jSquash:
`);
for (const [name, f] of [['libavif', 'libavif-LICENSE.txt'], ['libaom', 'libaom-LICENSE.txt'], ['libaom patent license', 'libaom-PATENTS.txt'], ['libwebp and libsharpyuv', 'libwebp-COPYING.txt'], ['libwebp patent grant', 'libwebp-PATENTS.txt'], ['libyuv', 'libyuv-LICENSE.txt']]) {
  out.push(`--- ${name} ---\n\n${text(join(LIC, f))}\n`);
}
out.push(`MozJPEG 3.3.1 (https://github.com/mozilla/mozjpeg), the JPEG codec in
@jsquash/jpeg (mozjpeg_enc.wasm, mozjpeg_dec.wasm). This software is based in
part on the work of the Independent JPEG Group. MozJPEG is libjpeg-turbo with
Mozilla's encoder changes, under the IJG License, the Modified (3-clause) BSD
License and the zlib License (LICENSE.md and README.ijg below; @jsquash/jpeg's
own LICENSE.codec.md in section 1 is the same roll-up).
`);
for (const [name, f] of [['MozJPEG LICENSE.md', 'mozjpeg-LICENSE.txt'], ['MozJPEG README.ijg (the IJG License is in its LEGAL ISSUES section)', 'mozjpeg-README.ijg.txt']]) {
  out.push(`--- ${name} ---${NL}${NL}${text(join(LIC, f))}${NL}`);
}
out.push(`oxipng 9.1.1 (MIT, https://github.com/shssoichiro/oxipng) with libdeflate
(MIT) and the Rust crates listed below, compiled into @jsquash/oxipng's
squoosh_oxipng_bg.wasm (single-threaded build).
`);
out.push(`--- oxipng, libdeflate and the Rust crates in squoosh_oxipng_bg.wasm ---${NL}${NL}${text(join(LIC, 'oxipng-crates-LICENSES.txt'))}${NL}`);
out.push(`${thin}

4. Files kept in this repository
${rule}

Arimo 1.31 (Regular, Bold, Italic, Bold Italic), four TrueType files in
vendor/arimo, unmodified, served as pdfjs/standard_fonts/Arimo-*.ttf. They draw
PDF text in Helvetica or Arial that a PDF names without including the font.
Copyright 2010-2014 Google Inc. All Rights Reserved. Licensed under the Apache
License, Version 2.0. Arimo is a trademark of Google Inc. and may be registered
in certain jurisdictions. Source: the Chrome OS core fonts release
croscorefonts-1.31.0 (vendor/arimo/README.txt gives its address and checksums).

${text(join(root, 'vendor', 'arimo', 'LICENSE.txt'))}
`);
out.push(`${thin}\n\nEnd of notices.\n`);

const result = out.join('\n').replace(/\n{4,}/g, '\n\n\n');
writeFileSync(join(root, 'THIRD-PARTY-NOTICES.txt'), result);
console.log(`THIRD-PARTY-NOTICES.txt written: ${bundled.length} packages, ${(result.length / 1024).toFixed(0)} KB`);
