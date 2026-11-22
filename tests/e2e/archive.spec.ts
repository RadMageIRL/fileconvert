import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PYTHON, convert, expectDone, fx, openApp, pillow, ready, row, save, tempDir } from './helpers';

// Archive extraction (v0.2.0). The archives are made by Python's zipfile, tarfile and gzip modules, not by
// FileConvert, and several are hostile: links, paths that climb out, nested archives, a decompression bomb.

/** Makes the test archives with Python and returns their paths. */
function makeArchives(): Record<string, string> {
  const dir = tempDir();
  const script = [
    'import sys, os, io, zipfile, tarfile, gzip',
    'd = sys.argv[1]; png = open(sys.argv[2], "rb").read(); csv = open(sys.argv[3], "rb").read()',
    'inner = io.BytesIO()',
    'with zipfile.ZipFile(inner, "w") as z: z.writestr("deep.txt", "deep")',
    'with zipfile.ZipFile(os.path.join(d, "mixed.zip"), "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr("pictures/alpha.png", png)',
    '    z.writestr("data/people.csv", csv)',
    '    z.writestr("README", "read me")',
    '    z.writestr("blob.bin", bytes(range(256)) * 4)',
    '    z.writestr("inner.zip", inner.getvalue())',
    '    z.writestr("../../escape.png", png)',
    '    z.writestr("copy/alpha.png", png)',
    '    info = zipfile.ZipInfo("link-to-passwd"); info.create_system = 3; info.external_attr = (0o120777 << 16); z.writestr(info, "/etc/passwd")',
    'with tarfile.open(os.path.join(d, "bundle.tar.gz"), "w:gz") as t:',
    '    for name, data in [("docs/people.csv", csv), ("/abs/alpha.png", png)]:',
    '        ti = tarfile.TarInfo(name); ti.size = len(data); t.addfile(ti, io.BytesIO(data))',
    '    ln = tarfile.TarInfo("evil-link"); ln.type = tarfile.SYMTYPE; ln.linkname = "/etc/passwd"; t.addfile(ln)',
    '    hl = tarfile.TarInfo("hard-link"); hl.type = tarfile.LNKTYPE; hl.linkname = "docs/people.csv"; t.addfile(hl)',
    'with zipfile.ZipFile(os.path.join(d, "bomb.zip"), "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr("zeros.bin", bytes(200 * 1024 * 1024))',
    'with zipfile.ZipFile(os.path.join(d, "large.zip"), "w", zipfile.ZIP_STORED) as z:',
    '    z.writestr("random.bin", os.urandom(150 * 1024 * 1024))',
    'open(os.path.join(d, "notes.txt.gz"), "wb").write(gzip.compress(b"plain notes"))',
  ].join('\n');
  execFileSync(PYTHON, ['-I', '-c', script, dir, fx('image/alpha.png'), fx('data/people.csv')]);
  return Object.fromEntries(['mixed.zip', 'bundle.tar.gz', 'bomb.zip', 'large.zip', 'notes.txt.gz'].map(n => [n, join(dir, n)]));
}

let A: Record<string, string>;
test.beforeAll(() => { A = makeArchives(); });

const tempFiles = (page: Page) => page.evaluate(async () => (await (window as unknown as { __fileconvert: { tempFiles(): Promise<string[]> } }).__fileconvert.tempFiles()).filter(n => n.startsWith('arc-')));

test('a ZIP is unpacked, not converted: files to download or convert, links and climbing paths handled', async ({ page }, info) => {
  const w = await openApp(page);
  await page.locator('#picker').setInputFiles([A['mixed.zip']]);
  await ready(page, 'mixed.zip');
  const r = row(page, 'mixed.zip');
  await expect(r.locator('.job-notes')).toContainText('FileConvert does not turn one archive format into another');
  await expect(r.getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('#convert-all')).toBeDisabled();
  await r.getByRole('button', { name: 'Extract files' }).click();
  await expect(r).toHaveClass(/done/, { timeout: 60_000 });
  await expect(r.locator('.job-status')).toContainText('Unpacked');
  const items = r.locator('.arc-item:not(.skipped) .arc-path');
  await expect(items).toHaveText(['pictures/alpha.png', 'data/people.csv', 'README', 'blob.bin', 'inner.zip', 'escape.png', 'copy/alpha.png']);
  await expect(r.locator('.arc-item.skipped')).toContainText('Not unpacked: a link to another file; links are not unpacked');
  await expect(r.locator('.job-notes')).toContainText('1 path pointed outside the archive');
  // README is plain text, which converts to PDF; the unknown binary cannot be converted.
  await expect(r.locator('.arc-item.no-convert .arc-path')).toHaveText(['blob.bin']);

  // Download one file straight from the archive: the same bytes that went in.
  const [dl] = await Promise.all([page.waitForEvent('download'), r.getByRole('button', { name: 'Download data/people.csv' }).click()]);
  const csv = await save(dl, info);
  expect(readFileSync(csv.path)).toEqual(readFileSync(fx('data/people.csv')));
  const [dup] = await Promise.all([page.waitForEvent('download'), r.getByRole('button', { name: 'Download copy/alpha.png' }).click()]);
  expect(dup.suggestedFilename()).toBe('alpha (2).png');

  // Convert files from the archive without adding them again.
  await r.getByRole('button', { name: /Select all that can be converted \(6\)/ }).click();
  await r.getByRole('button', { name: 'Add 6 to the list' }).click();
  await expect(page.locator('li.job')).toHaveCount(7);
  await ready(page, 'escape.png');
  await convert(page, 'escape.png', 'JPG');
  await expectDone(page, 'escape.png');
  const [jpg] = await Promise.all([page.waitForEvent('download'), row(page, 'escape.png').locator('.outputs button').click()]);
  expect(pillow((await save(jpg, info)).path).format).toBe('JPEG');
  // The nested archive is a row of its own, unpacked only when asked.
  await ready(page, 'inner.zip');
  await expect(row(page, 'inner.zip').getByRole('button', { name: 'Extract files' })).toBeVisible();
  expect(w.outside).toEqual([]);
});

test('TAR inside gzip: files unpacked, absolute paths shown safely, symbolic and hard links listed', async ({ page }) => {
  await openApp(page);
  await page.locator('#picker').setInputFiles([A['bundle.tar.gz'], A['notes.txt.gz']]);
  await ready(page, 'bundle.tar.gz');
  await row(page, 'bundle.tar.gz').getByRole('button', { name: 'Extract files' }).click();
  await expect(row(page, 'bundle.tar.gz')).toHaveClass(/done/, { timeout: 60_000 });
  await expect(row(page, 'bundle.tar.gz').locator('.arc-item:not(.skipped) .arc-path')).toHaveText(['docs/people.csv', 'abs/alpha.png']);
  await expect(row(page, 'bundle.tar.gz').locator('.arc-item.skipped .arc-path')).toHaveText(['evil-link', 'hard-link']);
  await ready(page, 'notes.txt.gz');
  await row(page, 'notes.txt.gz').getByRole('button', { name: 'Extract files' }).click();
  await expect(row(page, 'notes.txt.gz').locator('.arc-item .arc-path')).toHaveText(['notes.txt']);
});

test('a decompression bomb is stopped by what it actually unpacks', async ({ page }) => {
  await openApp(page);
  await page.locator('#picker').setInputFiles([A['bomb.zip']]);
  await ready(page, 'bomb.zip');
  await row(page, 'bomb.zip').getByRole('button', { name: 'Extract files' }).click();
  await expect(row(page, 'bomb.zip')).toHaveClass(/done/, { timeout: 60_000 });
  await expect(row(page, 'bomb.zip').locator('.arc-item.skipped')).toContainText('expands more than 1000 times, a decompression bomb; stopped');
  await expect.poll(() => tempFiles(page)).toEqual([]);
});

test('unpacked files are deleted when nothing needs them, and a canceled extraction leaves nothing behind', async ({ page }) => {
  await openApp(page);
  await page.locator('#picker').setInputFiles([A['mixed.zip']]);
  await ready(page, 'mixed.zip');
  await row(page, 'mixed.zip').getByRole('button', { name: 'Extract files' }).click();
  await expect(row(page, 'mixed.zip')).toHaveClass(/done/, { timeout: 60_000 });
  expect((await tempFiles(page)).length).toBe(7);
  await row(page, 'mixed.zip').getByRole('checkbox', { name: 'Select data/people.csv' }).check();
  await row(page, 'mixed.zip').getByRole('button', { name: 'Add 1 to the list' }).click();
  await ready(page, 'people.csv');
  // The archive goes, but the file taken from it still needs its data.
  await row(page, 'mixed.zip').getByRole('button', { name: 'Remove mixed.zip' }).click();
  expect((await tempFiles(page)).length).toBe(7);
  await convert(page, 'people.csv', 'JSON');
  await expectDone(page, 'people.csv');
  await row(page, 'people.csv').getByRole('button', { name: 'Remove people.csv' }).click();
  await expect.poll(() => tempFiles(page)).toEqual([]);

  await page.locator('#picker').setInputFiles([A['large.zip']]);
  await ready(page, 'large.zip');
  await row(page, 'large.zip').getByRole('button', { name: 'Extract files' }).click();
  await expect(row(page, 'large.zip').locator('.job-status')).toContainText('Unpacking');
  await row(page, 'large.zip').getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'large.zip')).toHaveClass(/canceled/);
  await expect.poll(() => tempFiles(page), { timeout: 15_000 }).toEqual([]);
});
