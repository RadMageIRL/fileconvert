// The "Remove PDF metadata" tool: the document information (title, author, dates and the rest), XMP metadata and the
// other places a PDF keeps metadata, removed in the PDF worker (src/engines/pdf/metadata.ts, which lists them), and the
// file written whole with a new identifier. Everything that makes up the document stays: its pages, comments,
// bookmarks, links, form fields, attachments and signatures; the result says which of these it has, since they can
// name people too. Removing metadata does not make a document anonymous.

import type { ToolDefinition } from '../app/tools';
import { formatBytes } from '../core/limits';
import { safeBase } from '../core/naming';
import type { MetadataReport } from '../engines/pdf/metadata';
import type { CleanReport, SignatureInfo } from '../engines/pdf/structure';
import { allowance, checkWith, inspectPdf, listNames, plural } from './pdf-common';

const INFO_NAMES: Record<string, string> = {
  Title: 'title', Author: 'author', Subject: 'subject', Keywords: 'keywords', Creator: 'creator (the app that made it)',
  Producer: 'producer', CreationDate: 'creation date', ModDate: 'modification date', Trapped: 'trapping flag',
};

/** Every item of a list, never shortened: "a", "a and b", "a, b and c". */
const all = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] ?? '');

/** What metadata a PDF has, in words: "title, author, XMP metadata, metadata in 2 JPEG pictures (EXIF, XMP)". */
export function metadataWords(r: MetadataReport): string[] {
  const words: string[] = [];
  const custom = r.info.filter(k => !INFO_NAMES[k]);
  words.push(...r.info.filter(k => INFO_NAMES[k]).map(k => INFO_NAMES[k]));
  if (custom.length) words.push(`${plural(custom.length, 'custom field')} (${listNames(custom)})`);
  if (r.xmp) words.push('XMP metadata');
  if (r.objectXmp) words.push(`XMP on ${plural(r.objectXmp, 'other part')} (pages, pictures or fonts)`);
  if (r.pieceInfo) words.push(`application data in ${plural(r.pieceInfo, 'place')}`);
  if (r.lastModified) words.push(`${plural(r.lastModified, 'modification date')} of pages or drawings`);
  if (r.thumbnails) words.push(plural(r.thumbnails, 'page thumbnail'));
  if (r.spiderInfo) words.push('web capture information');
  if (r.jpegs) words.push(`metadata in ${plural(r.jpegs, 'JPEG picture')} (${r.jpegKinds.join(', ')})`);
  return words;
}

export const tool: ToolDefinition = {
  id: 'remove-pdf-metadata',
  title: 'Remove PDF metadata',
  summary: 'Removes the title, author, dates, XMP and other metadata a PDF carries, and keeps everything on its pages.',
  accepts: ['pdf'],
  minInputs: 1,
  maxInputs: 1,
  ordered: false,
  options: [],
  action: 'Remove the metadata',
  confirmLabel: 'Remove anyway; the signature will no longer be valid',
  inspect: inspectPdf('Removing its metadata', {
    metadata: true,
    describe: r => {
      const words = r.metadata ? metadataWords(r.metadata) : [];
      return words.length ? `Has ${all(words)}.` : 'No document metadata found; it can still be rewritten with a new file identifier.';
    },
  }),
  check(inputs) {
    return checkWith(() => undefined)(inputs);
  },
  async run(inputs, _values, ctx) {
    const input = inputs[0];
    const r = await ctx.engines.pdf.run<{ bytes: Uint8Array; report: MetadataReport; clean: CleanReport; signature: SignatureInfo }>('removeMetadata', { file: input.file, allowance: allowance() }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
    const m = r.report;
    const words = metadataWords(m);
    const details: string[] = [];
    details.push(words.length ? `Removed: ${all(words)}.` : 'The PDF had no document metadata.');
    details.push(m.id ? 'The file identifier, which ties copies of a file together, was replaced by a new one.' : 'A new file identifier was added.');
    details.push('The file was written whole: earlier versions saved inside it, and parts nothing uses, are not kept.');
    const warnings: string[] = [];
    if (r.signature.signed) warnings.push('The digital signature is no longer valid. The signature field keeps the signer\'s name and certificate.');
    if (m.pdfa) warnings.push('The PDF said it conforms to PDF/A, which needs XMP metadata; the result no longer does.');
    if (m.pdfua) warnings.push('The PDF said it conforms to PDF/UA (accessible PDF), which needs XMP metadata; the result no longer does. Its accessibility tags are kept.');
    if (m.jpegsUnread) warnings.push(`${plural(m.jpegsUnread, 'JPEG picture')} stored with another compression on top ${m.jpegsUnread === 1 ? 'was' : 'were'} not opened, so any EXIF inside ${m.jpegsUnread === 1 ? 'it stays' : 'them stays'}.`);
    const stays = [
      m.stays.authoredNotes && `${plural(m.stays.authoredNotes, 'comment')} with the author's name`,
      m.stays.attachments && `${plural(m.stays.attachments, 'attached file')} with ${m.stays.attachments === 1 ? 'its' : 'their'} names`,
      m.stays.formValues && `${plural(m.stays.formValues, 'filled-in form field')}`,
      m.stays.signatures && plural(m.stays.signatures, 'signature'),
      m.stays.scripts && 'document scripts',
    ].filter(Boolean) as string[];
    if (stays.length) warnings.push(`Kept, since they are part of the document: ${all(stays)}.`);
    warnings.push('This does not make the document anonymous: names and other details can still be in its text, pictures, comments, attachments and form fields, and in hidden content.');
    return {
      outputs: [{ blob, base: `${safeBase(input.name)}-no-metadata`, ext: 'pdf', note: `${plural(r.clean.pages, 'page')}, ${formatBytes(blob.size)}`, details }],
      warnings,
      summary: words.length ? `${plural(words.length, 'kind')} of metadata removed` : 'No metadata found; rewritten',
    };
  },
};
