Arimo 1.31, four TrueType files, unmodified

What they are for: pdf.js draws PDF text set in Helvetica or Arial that a PDF names
without including the font. pdf.js asks for its sans-serif font under the names
LiberationSans-Regular.ttf, -Bold, -Italic and -BoldItalic; FileConvert's render
worker answers those requests with these files instead (src/engines/pdf/render.ts,
FONT_FILES). Arimo has the same design and the same character widths as Liberation
Sans and Arial, so text is placed exactly as before.

License: Apache License 2.0 (LICENSE.txt, the unmodified license text). Each font's
name table says: "Copyright 2010-2014 Google Inc. All Rights Reserved." and
"Licensed under the Apache License, Version 2.0". "Arimo is a trademark of Google
Inc. and may be registered in certain jurisdictions." The fonts carry no NOTICE file.

Source: the Chrome OS core fonts release croscorefonts-1.31.0, as Google publishes it
for Chrome OS builds:
https://commondatastorage.googleapis.com/chromeos-localmirror/distfiles/croscorefonts-1.31.0.tar.bz2
SHA-256 of that archive:
672c3487883ec1ef83d9254240d4327b014212abc823d06d15816095867315e1

The files here are copied from the archive byte for byte:

a5cb71302ce735698dfc756943c5bbcfbcc734e117ad452ccb3cb036e07dbd36  Arimo-Regular.ttf
3251104cea71aee741bb5ce63370b1e84b5f4326ecf4259db8889935eb01219b  Arimo-Bold.ttf
eb8498900d06aa4fbde30e1a539d1a04334fe9d380765f1dba01d5670d3cb2b0  Arimo-Italic.ttf
e78a9c639a5e4210d799acae0757ed8e8e6479ba1464682476a9873f71463244  Arimo-BoldItalic.ttf

The Arimo that Google Fonts distributes today is published under the SIL Open Font
License 1.1 instead; this release is kept for its Apache License.
