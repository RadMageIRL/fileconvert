import { expect, test } from '@playwright/test';
import { addFiles, convert, cspViolations, download, expectDone, fx, openApp, pillow } from './helpers';

test('the page loads with no errors, no CSP violations and no outside requests, and converts a PNG to JPG', async ({ page }, info) => {
  const w = await openApp(page);
  await expect(page.getByRole('heading', { name: 'FileConvert', level: 1 })).toBeVisible();
  await addFiles(page, [fx('image/alpha.png')]);
  await convert(page, 'alpha.png', 'JPG');
  await expectDone(page, 'alpha.png');
  const { path, filename } = await download(page, 'alpha.png', info);
  expect(filename).toBe('alpha.jpg');
  const im = pillow(path);
  expect(im.format).toBe('JPEG');
  expect(im.size).toEqual([320, 200]);
  expect(w.errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  expect(w.outside).toEqual([]);
});
