import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fx, openApp, save } from './helpers';

// The tool workspace, which the PDF and image tools will run in. No tool ships yet, so these tests open the
// workspace with a small tool defined right here (it joins text files in the chosen order) and check what every
// tool relies on: checking files by their bytes, ordering by keyboard and by dragging, options, progress,
// cancel, errors, unique result names, downloads and the ZIP.

type Kind = 'join' | 'hang' | 'broken';

async function openTool(page: Page, kind: Kind = 'join'): Promise<void> {
  await page.evaluate(async k => {
    const app = (window as unknown as { __fileconvert: { openWorkspace(def: unknown): Promise<unknown> } }).__fileconvert;
    await app.openWorkspace({
      id: 'join', title: 'Join text files', summary: 'Joins text files in the order shown.',
      accepts: ['txt'], minInputs: 2, maxInputs: 4, ordered: true, action: 'Join files',
      options: [
        { kind: 'text', key: 'sep', label: 'Separator', value: '|', maxLength: 5 },
        { kind: 'check', key: 'two', label: 'Make two copies', value: false },
      ],
      check: (_inputs: unknown[], values: Record<string, unknown>) => values.sep === '' ? 'Enter a separator.' : null,
      run: async (inputs: Array<{ file: File }>, values: Record<string, unknown>, ctx: { signal: AbortSignal; progress(p: object): void }) => {
        if (k === 'hang') return new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError'))));
        if (k === 'broken') throw new Error('Broken on purpose.');
        ctx.progress({ fraction: 0.5, stage: 'Joining' });
        const text = (await Promise.all(inputs.map(i => i.file.text()))).map(t => t.trim()).join(String(values.sep));
        const outputs = [{ blob: new Blob([text], { type: 'text/plain' }), base: 'joined', ext: 'txt' }];
        if (values.two) outputs.push({ blob: new Blob([text], { type: 'text/plain' }), base: 'joined', ext: 'txt' });
        return { outputs, warnings: ['Line endings were trimmed.'], summary: `${inputs.length} files joined` };
      },
    });
  }, kind);
  await expect(page.getByRole('heading', { name: 'Join text files', level: 2 })).toBeVisible();
}

const text = (name: string, body: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
const ws = (page: Page) => page.locator('#workspace');
const order = (page: Page) => ws(page).locator('.ws-item:not(.rejected) .job-name');

async function addThree(page: Page): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles([text('a.txt', 'A\n'), text('b.txt', 'B\n'), text('c.txt', 'C\n')]);
  await expect(order(page)).toHaveText(['a.txt', 'b.txt', 'c.txt']);
}

test('the workspace replaces the converter, checks files by their contents and says what is missing', async ({ page }) => {
  const w = await openApp(page);
  await openTool(page);
  await expect(page.locator('#drop')).toBeHidden();
  const run = ws(page).getByRole('button', { name: 'Join files' });
  await expect(run).toBeDisabled();
  await ws(page).locator('input[type=file]').setInputFiles([text('a.txt', 'A'), { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: readFileSync(fx('image/photo.jpg')) }]);
  await expect(ws(page).locator('.ws-item.rejected .job-error')).toHaveText('Join text files takes TXT files; this is JPEG image.');
  await expect(ws(page).locator('.ws-why')).toHaveText('Add at least 2 files.');
  await ws(page).locator('input[type=file]').setInputFiles([text('b.txt', 'B'), text('c.txt', 'C'), text('d.txt', 'D'), text('e.txt', 'E')]);
  await expect(ws(page).locator('.ws-why')).toHaveText('This tool takes up to 4 files. Remove 1.');
  await ws(page).getByRole('button', { name: 'Remove e.txt' }).click();
  await ws(page).getByRole('button', { name: 'Remove photo.jpg' }).click();
  await expect(run).toBeEnabled();
  await ws(page).getByLabel('Separator').fill('');
  await ws(page).getByLabel('Separator').blur();
  await expect(ws(page).locator('.ws-why')).toHaveText('Enter a separator.');
  await expect(run).toBeDisabled();
  expect(w.errors).toEqual([]);
});

test('files are reordered from the keyboard, and the result follows the order', async ({ page }, info) => {
  await openApp(page);
  await openTool(page);
  await addThree(page);
  await expect(ws(page).getByRole('button', { name: 'Move a.txt up' })).toBeDisabled();
  const up = ws(page).getByRole('button', { name: 'Move c.txt up' });
  await up.focus();
  await page.keyboard.press('Enter');
  await expect(order(page)).toHaveText(['a.txt', 'c.txt', 'b.txt']);
  await expect(ws(page).getByRole('button', { name: 'Move c.txt up' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(order(page)).toHaveText(['c.txt', 'a.txt', 'b.txt']);
  await expect(page.locator('#announcer')).toHaveText('c.txt moved to position 1 of 3.');
  // Its Move up button is now disabled, so the focus stays on the row with Move down.
  await expect(ws(page).getByRole('button', { name: 'Move c.txt down' })).toBeFocused();
  await ws(page).getByRole('button', { name: 'Join files' }).click();
  await expect(ws(page).locator('.ws-state.done')).toHaveText('Done: 1 file, 5 B. 3 files joined');
  await expect(ws(page).locator('.job-notes')).toHaveText('Line endings were trimmed.');
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).getByRole('button', { name: 'Download joined.txt' }).click()]);
  const { path, filename } = await save(dl, info);
  expect(filename).toBe('joined.txt');
  expect(readFileSync(path, 'utf8')).toBe('C|A|B');
});

test('files are reordered by dragging', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit on Windows does not run this app.');
  await openApp(page);
  await openTool(page);
  await addThree(page);
  const rows = ws(page).locator('.ws-item');
  const height = (await rows.first().boundingBox())!.height;
  // Dropped on the top edge of a row goes before it, on the bottom edge after it.
  await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 40, y: 3 } });
  await expect(order(page)).toHaveText(['c.txt', 'a.txt', 'b.txt']);
  await rows.nth(0).dragTo(rows.nth(2), { targetPosition: { x: 40, y: height - 3 } });
  await expect(order(page)).toHaveText(['a.txt', 'b.txt', 'c.txt']);
});

test('changing an option clears old results; results get unique names and come as a ZIP', async ({ page }, info) => {
  await openApp(page);
  await openTool(page);
  await addThree(page);
  await ws(page).getByRole('button', { name: 'Join files' }).click();
  await expect(ws(page).getByRole('button', { name: 'Download joined.txt' })).toBeVisible();
  await ws(page).getByLabel('Make two copies').check();
  await expect(ws(page).locator('.ws-out')).toBeHidden();
  await ws(page).getByRole('button', { name: 'Join files' }).click();
  await expect(ws(page).locator('.outputs button')).toHaveText(['Download joined.txt', 'Download joined (2).txt', 'Download all (ZIP, 2)']);
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).getByRole('button', { name: 'Download all (ZIP, 2)' }).click()]);
  const { path, filename } = await save(dl, info);
  expect(filename).toMatch(/^Join text files \d{4}-\d{2}-\d{2}\.zip$/);
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(new Uint8Array(readFileSync(path)));
  expect(Object.keys(entries).sort()).toEqual(['joined (2).txt', 'joined.txt']);
  expect(new TextDecoder().decode(entries['joined.txt'])).toBe('A|B|C');
});

test('a run can be canceled, a failure is shown, and files dropped on the page go to the workspace', async ({ page }) => {
  await openApp(page);
  await openTool(page, 'hang');
  await addThree(page);
  await ws(page).getByRole('button', { name: 'Join files' }).click();
  await expect(ws(page).getByRole('progressbar')).toBeVisible();
  await expect(ws(page).getByRole('button', { name: 'Remove a.txt' })).toBeDisabled();
  await ws(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(ws(page).locator('.ws-state.canceled')).toHaveText('Canceled.');
  await expect(ws(page).getByRole('button', { name: 'Join files' })).toBeEnabled();

  await openTool(page, 'broken');
  await addThree(page);
  await ws(page).getByRole('button', { name: 'Join files' }).click();
  await expect(ws(page).locator('.ws-run .job-error')).toHaveText('Broken on purpose.');

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['D'], 'd.txt', { type: 'text/plain' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(order(page)).toHaveText(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  await expect(page.locator('li.job')).toHaveCount(0);
});
