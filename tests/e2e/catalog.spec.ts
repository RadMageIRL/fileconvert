import { expect, test } from '@playwright/test';
import { PAGES } from '../../src/core/pages';
import { openApp } from './helpers';

// The catalog: every page is listed as a link in the HTML, the search narrows the list as you type, the
// category buttons filter it, and conversions without a page of their own are answered from the registry.

const visible = (page: import('@playwright/test').Page) => page.locator('.cat-item:not([hidden]) .cat-name');

test('the catalog lists every page, and the search narrows it as you type', async ({ page }) => {
  const w = await openApp(page);
  await expect(page.locator('.cat-item')).toHaveCount(PAGES.length);
  const search = page.getByRole('searchbox', { name: 'Search conversions' });
  await search.fill('heic');
  await expect(visible(page)).toHaveText(['HEIC to JPG', 'HEIC to PNG']);
  await expect(page.locator('#catalog-status')).toHaveText('2 pages match.');
  await expect(page.locator('.cat-group:not([hidden]) h3')).toHaveText(['Images']);
  await search.fill('iphone video');
  await expect(visible(page)).toHaveText(['MOV to MP4']);
  await search.fill('Convert MP4 to MP3');
  await expect(visible(page)).toHaveText(['MP4 to MP3']);
  await search.fill('excel');
  await expect(visible(page)).toHaveText(['JSON to CSV', 'CSV to JSON', 'XLSX to CSV']);
  await search.fill('');
  await expect(page.locator('.cat-item:not([hidden])')).toHaveCount(PAGES.length);
  await expect(page.locator('#catalog-status')).toHaveText('');
  expect(w.errors).toEqual([]);
});

test('the category buttons filter the list and show which one is on', async ({ page }) => {
  await openApp(page);
  const audio = page.getByRole('group', { name: 'Show category' }).getByRole('button', { name: 'Audio' });
  await audio.click();
  await expect(audio).toHaveAttribute('aria-pressed', 'true');
  await expect(visible(page)).toHaveText(['MP4 to MP3', 'WAV to MP3', 'M4A to MP3', 'FLAC to MP3']);
  await page.getByRole('searchbox', { name: 'Search conversions' }).fill('flac');
  await expect(visible(page)).toHaveText(['FLAC to MP3']);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search conversions' }).fill('');
  await expect(page.locator('.cat-item:not([hidden])')).toHaveCount(PAGES.length);
});

test('conversions without a page, and formats that are not supported, are answered', async ({ page }) => {
  await openApp(page);
  const search = page.getByRole('searchbox', { name: 'Search conversions' });
  const more = page.locator('#catalog-more');
  await search.fill('bmp to tiff');
  await expect(more).toContainText('BMP to TIFF is supported. Add your file to the converter at the top of the page and choose TIFF.');
  await expect(page.locator('#catalog-status')).toHaveText('No page matches.');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), more.getByRole('button', { name: 'Choose files' }).click()]);
  expect(chooser.isMultiple()).toBe(true);
  await search.fill('avi to mp4');
  await expect(more).toContainText('AVI video is not supported yet.');
  await search.fill('jpg to heic');
  await expect(more).toContainText('HEIC is read but not written');
  await search.fill('docx to pdf');
  await expect(more).toContainText('FileConvert does not convert DOCX to PDF.');
  await search.fill('heic to jpg');
  await expect(more).toBeHidden();
  await expect(visible(page)).toHaveText(['HEIC to JPG']);
});

test('on a page, its own entry in the catalog is marked as the current page', async ({ page }) => {
  await page.goto('./csv-to-json/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  const current = page.locator('.cat-item a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current.locator('.cat-name')).toHaveText('CSV to JSON');
  await page.getByRole('searchbox', { name: 'Search conversions' }).fill('json');
  await expect(visible(page)).toHaveText(['JSON to CSV', 'CSV to JSON']);
});
