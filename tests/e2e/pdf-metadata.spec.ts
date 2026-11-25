import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fx, openApp, pyRead, save, unexpectedViolations } from './helpers';

// Remove PDF metadata (v0.2.0, Phase 2) in the browser: every result read with qpdf (every stream decoded but JPEG
// data), the file's own bytes and every stream in them that inflates, pypdf, Pillow and PDFium (tests/e2e/readers.py,
// kind pdfmeta), none of which shares code with FileConvert. The fixture (tools/make-pdf-render-fixtures.py) holds a
// marker word in every place metadata can be (MARK-...) and in what has to stay (KEEP-...).

interface Meta {
  qpdf: { ok: boolean; out: string }; words: string[]; info: Record<string, string> | null; xmp: boolean; id: string[] | null; catalog: string[];
  jpegs: Array<{ markers: string[]; trailing: number; pixels: string; size: number }>;
  annots: Array<{ subtype: string; author: string | null; contents: string | null }>; outline: string[]; fields: Record<string, string>; attachments: string[];
  renders: string[]; pieceInfo: number; lastModified: number; thumb: number; metadataKeys: number; sha256: string;
}

const ws = (page: Page) => page.locator('#workspace');

async function openTool(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('remove-pdf-metadata'));
  await expect(page.getByRole('heading', { name: 'Remove PDF metadata', level: 2 })).toBeVisible();
}

async function add(page: Page, path: string): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(path);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

async function runAndSave(page: Page, info: TestInfo): Promise<string> {
  await ws(page).getByRole('button', { name: 'Remove the metadata' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).locator('.ws-out button', { hasText: /^Download / }).first().click()]);
  return (await save(dl, info)).path;
}

test('metadata in every place it can be is removed, older versions included; the document stays as it was', async ({ page }, info) => {
  const w = await openApp(page);
  await openTool(page);
  const src = fx('pdf-render/metadata.pdf');
  await add(page, src);
  // What it has is listed as it is added.
  await expect(ws(page).locator('.ws-item .job-notes')).toHaveText('Has title, author, subject, keywords, creator (the app that made it), producer, creation date, modification date, trapping flag, 1 custom field (Department), XMP metadata, XMP on 2 other parts (pages, pictures or fonts), application data in 2 places, 3 modification dates of pages or drawings, 1 page thumbnail, web capture information and metadata in 1 JPEG picture (EXIF, IPTC and Photoshop data, XMP, comments, data after the picture).');
  const out = await runAndSave(page, info);
  const before = pyRead<Meta>('pdfmeta', src);
  const after = pyRead<Meta>('pdfmeta', out);
  // The source holds every marker, so finding none afterwards means something.
  expect(before.words.filter(x => x.startsWith('MARK-'))).toHaveLength(23);
  expect(after.qpdf.ok).toBe(true);
  expect(after.words.filter(x => x.startsWith('MARK-'))).toEqual([]);
  expect(after.words.filter(x => x.startsWith('KEEP-'))).toEqual(before.words.filter(x => x.startsWith('KEEP-')));
  expect(after.info).toBeNull();
  expect(after.xmp).toBe(false);
  expect([after.pieceInfo, after.lastModified, after.thumb, after.metadataKeys]).toEqual([0, 0, 0, 0]);
  expect(after.catalog).toEqual(['/AcroForm', '/Names', '/Outlines', '/Pages', '/Type']);
  // A new identifier, not the old one.
  expect(after.id![0]).toMatch(/^[0-9A-F]{32}$/);
  expect(after.id![0]).not.toBe(before.id![0]);
  // The JPEG keeps its tables, frame and scan byte for byte and decodes to the same pixels; its metadata segments and
  // the data after its end are gone.
  expect(before.jpegs[0].markers.slice(0, 4)).toEqual(['E1:Exif', 'E1:http://ns.ad', 'ED:Photoshop 3.', 'FE']);
  expect(after.jpegs[0].markers).toEqual(before.jpegs[0].markers.slice(4));
  expect(after.jpegs[0].trailing).toBe(0);
  expect(after.jpegs[0].pixels).toBe(before.jpegs[0].pixels);
  // Pages look exactly the same; comments, bookmarks, form values and attachments stay.
  expect(after.renders).toEqual(before.renders);
  expect(after.annots).toEqual(before.annots);
  expect(after.outline).toEqual(before.outline);
  expect(after.fields).toEqual(before.fields);
  expect(after.attachments).toEqual(before.attachments);
  // The result says what was removed, what stays, and that the document is not anonymous now.
  const notes = ws(page).locator('.ws-out');
  await expect(notes).toContainText('The file identifier, which ties copies of a file together, was replaced by a new one.');
  await expect(notes).toContainText('The PDF said it conforms to PDF/A, which needs XMP metadata; the result no longer does.');
  await expect(notes).toContainText('Kept, since they are part of the document: 1 comment with the author\'s name, 1 attached file with its names and 1 filled-in form field.');
  await expect(notes).toContainText('This does not make the document anonymous');
  expect(w.errors).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('the same PDF always gives the same file, whose identifier comes from its own bytes', async ({ page }, info) => {
  await openApp(page);
  await openTool(page);
  await add(page, fx('pdf/merge-a.pdf'));
  await expect(ws(page).locator('.ws-item .job-notes')).toHaveText('Has title, author, subject and XMP metadata.');
  const a = await runAndSave(page, info);
  // Running again (an option change or a new run) makes the very same bytes.
  const b = await runAndSave(page, info);
  expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  const src = pyRead<Meta>('pdfmeta', fx('pdf/merge-a.pdf'));
  const out = pyRead<Meta>('pdfmeta', a);
  expect(out.qpdf.ok).toBe(true);
  expect(out.info).toBeNull();
  expect(out.renders).toEqual(src.renders);
  expect(out.fields).toEqual(src.fields);
  expect(out.outline).toEqual(src.outline);
});

test('a signed PDF asks first, an encrypted one is refused, and one without metadata still gets a new identifier', async ({ page }, info) => {
  await openApp(page);
  await openTool(page);
  await add(page, fx('pdf/signed.pdf'));
  await expect(ws(page).locator('.ws-confirm')).toContainText('is digitally signed. Removing its metadata changes it, so its signature will no longer be valid');
  await expect(ws(page).getByRole('button', { name: 'Remove the metadata' })).toBeDisabled();
  await ws(page).getByLabel('Remove anyway; the signature will no longer be valid').check();
  await expect(ws(page).getByRole('button', { name: 'Remove the metadata' })).toBeEnabled();
  await ws(page).getByRole('button', { name: 'Remove signed.pdf' }).click();
  await ws(page).locator('input[type=file]').setInputFiles(fx('pdf/encrypted-owner.pdf'));
  await expect(ws(page).locator('.job-error')).toContainText('This PDF is encrypted, so FileConvert does not open it.');
  await ws(page).getByRole('button', { name: 'Remove encrypted-owner.pdf' }).click();
  await add(page, fx('pdf-render/rotations.pdf'));
  await expect(ws(page).locator('.ws-item .job-notes')).toHaveText('No document metadata found; it can still be rewritten with a new file identifier.');
  const out = pyRead<Meta>('pdfmeta', await runAndSave(page, info));
  expect(out.qpdf.ok).toBe(true);
  expect(out.id![0]).toMatch(/^[0-9A-F]{32}$/);
  expect(out.renders).toEqual(pyRead<Meta>('pdfmeta', fx('pdf-render/rotations.pdf')).renders);
  await expect(ws(page).locator('.ws-out')).toContainText('The PDF had no document metadata.');
});
