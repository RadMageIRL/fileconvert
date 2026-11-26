import { expect, test } from '@playwright/test';
import { PAGES } from '../../src/core/pages';
import { openApp } from './helpers';

// The catalog: every page is listed as a link in the HTML, the search narrows the list as you type, the
// category buttons filter it, and conversions without a page of their own are answered from the registry.

const visible = (page: import('@playwright/test').Page) => page.locator('.cat-item:not([hidden]) .cat-name');

test('the catalog lists every page, and the search narrows it as you type', async ({ page }) => {
  const w = await openApp(page);
  await expect(page.locator('.cat-item')).toHaveCount(PAGES.length);
  // Every tool can run in this browser, so none is marked as unavailable (WebKit as Playwright runs it marks PDF to images).
  await expect(page.locator('.unavailable')).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Search conversions' });
  await search.fill('heic');
  // The TIFF tool and Images to PDF take HEIC pictures too.
  await expect(visible(page)).toHaveText(['HEIC to JPG', 'HEIC to PNG', 'Combine images into a TIFF', 'Images to PDF']);
  await expect(page.locator('#catalog-status')).toHaveText('4 pages match.');
  await expect(page.locator('.cat-group:not([hidden]) h3')).toHaveText(['Images', 'Documents']);
  await search.fill('iphone video');
  await expect(visible(page)).toHaveText(['MOV to MP4']);
  await search.fill('Convert MP4 to MP3');
  await expect(visible(page)).toHaveText(['MP4 to MP3']);
  await search.fill('excel');
  await expect(visible(page)).toHaveText(['JSON to CSV', 'CSV to JSON', 'XLSX to CSV', 'XLSX to JSON', 'JSON to XLSX', 'XLS to XLSX', 'XLS to CSV', 'ODS to XLSX', 'XML to XLSX']);
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
  await expect(visible(page)).toHaveText(['MP4 to MP3', 'WAV to MP3', 'M4A to MP3', 'FLAC to MP3', 'AIFF to MP3']);
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
  // A conversion request leaves tool pages out, even one that takes BMP pictures.
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
  // A conversion a tool does finds the tool's pages, not "does not convert".
  await search.fill('jpg to pdf');
  await expect(more).toBeHidden();
  await expect(visible(page)).toHaveText(['JPG to PDF', 'Images to PDF']);
  await search.fill('heic to pdf');
  await expect(visible(page)).toHaveText(['Images to PDF']);
});

test('on a page, its own entry in the catalog is marked as the current page', async ({ page }) => {
  await page.goto('./csv-to-json/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  const current = page.locator('.cat-item a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current.locator('.cat-name')).toHaveText('CSV to JSON');
  await page.getByRole('searchbox', { name: 'Search conversions' }).fill('json');
  await expect(visible(page)).toHaveText(['JSON to CSV', 'CSV to JSON', 'XLSX to JSON', 'JSON to XLSX', 'JSON Lines to CSV', 'JSON to JSON Lines']);
});
