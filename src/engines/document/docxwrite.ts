// Markdown to DOCX, the Word side, in the document worker: the docx library's HTML reader (docx/html) turns the
// sanitized HTML from ./markup.ts into Word paragraphs, lists, tables, links and pictures in the document's own
// styles (Heading 1, List Paragraph, Hyperlink), and the docx library writes the package. Nothing is downloaded:
// only pictures inside the HTML as data URLs can be included, and the page has already replaced the others with
// their description. The library is loaded only for this conversion.

export interface DocxResult { bytes: Uint8Array; warnings: string[] }

const PAGES = {
  LETTER: { width: 12240, height: 15840 },
  A4: { width: 11906, height: 16838 },
} as const;
/** One inch, in twentieths of a point. */
const INCH = 1440;

/** What docx/html reports, in words for the result. */
const WARNING_TEXT: Record<string, (n: number) => string> = {
  'unsupported-element': n => `${n} ${n === 1 ? 'part' : 'parts'} of the document that Word cannot hold ${n === 1 ? 'was' : 'were'} left out.`,
  'missing-image': n => `${n} ${n === 1 ? 'picture' : 'pictures'} without data ${n === 1 ? 'was' : 'were'} left out.`,
  'unsupported-image': n => `${n} ${n === 1 ? 'picture is' : 'pictures are'} in a format Word cannot show and ${n === 1 ? 'was' : 'were'} left out.`,
  'unsafe-link': n => `${n} ${n === 1 ? 'link' : 'links'} that could run code kept ${n === 1 ? 'its' : 'their'} text without the link.`,
  'too-deep': n => `${n} ${n === 1 ? 'part is' : 'parts are'} nested too deeply for Word and kept ${n === 1 ? 'its' : 'their'} text without formatting.`,
  'block-in-paragraph': n => `${n} ${n === 1 ? 'block' : 'blocks'} inside a paragraph became part of the paragraph.`,
  'table-in-note': n => `${n} ${n === 1 ? 'table' : 'tables'} in a footnote became ${n === 1 ? 'its' : 'their'} paragraphs.`,
  'invalid-math': n => `${n} ${n === 1 ? 'formula' : 'formulas'} could not be read and kept ${n === 1 ? 'its' : 'their'} text.`,
};

export async function renderDocx(html: string, title: string, pageSize: 'LETTER' | 'A4'): Promise<DocxResult> {
  const [docx, { htmlToContent }] = await Promise.all([import('docx'), import('docx/html')]);
  const { Document, Packer, ShadingType } = docx;
  const page = PAGES[pageSize];
  const counts = new Map<string, number>();
  const children = htmlToContent(html, {
    // The text width of the page, in pixels at 96 per inch.
    maxImageWidth: Math.floor((page.width - 2 * INCH) / INCH * 96),
    styleMap: { pre: 'CodeBlock', code: 'InlineCode' },
    onWarning: w => counts.set(w.code, (counts.get(w.code) ?? 0) + 1),
  });
  const shade = { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F3F6' };
  const doc = new Document({
    title,
    creator: '',
    lastModifiedBy: '',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 120, line: 276 } } },
      },
      paragraphStyles: [{
        id: 'CodeBlock', name: 'Code Block', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: 'Consolas', size: 19 },
        paragraph: { shading: shade, spacing: { before: 60, after: 120, line: 240 } },
      }],
      characterStyles: [{
        id: 'InlineCode', name: 'Inline Code', basedOn: 'DefaultParagraphFont', quickFormat: true,
        run: { font: 'Consolas', size: 20, shading: shade },
      }],
    },
    sections: [{
      properties: { page: { size: { width: page.width, height: page.height }, margin: { top: INCH, right: INCH, bottom: INCH, left: INCH } } },
      children: [...children],
    }],
  });
  const bytes = new Uint8Array(await Packer.toArrayBuffer(doc));
  const warnings: string[] = [];
  for (const [code, n] of counts) warnings.push((WARNING_TEXT[code] ?? (k => `${k} ${code} notes from the Word writer.`))(n));
  return { bytes, warnings };
}
