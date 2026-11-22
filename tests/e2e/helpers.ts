import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Download, type Page, type TestInfo } from '@playwright/test';

export const FIX = resolve('tests', 'fixtures');
export const fx = (p: string) => join(FIX, p);

/** Python with Pillow and pillow-heif, for decoding results independently of the browser. */
export const PYTHON = process.env.FILECONVERT_PYTHON || (existsSync(resolve('local/venv/Scripts/python.exe')) ? resolve('local/venv/Scripts/python.exe') : 'python');

/** The app's own origin: the local test server, or the live site when FILECONVERT_BASE is set. */
export const ORIGIN = new URL(process.env.FILECONVERT_BASE || 'http://127.0.0.1:4175/fileconvert/').origin;

export interface Watch {
  violations: string[];
  errors: string[];
  outside: string[];
}

/** Opens the app and records CSP violations, page errors and any request that leaves the app's origin. */
export async function openApp(page: Page): Promise<Watch> {
  const w: Watch = { violations: [], errors: [], outside: [] };
  page.on('pageerror', e => w.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) w.errors.push(m.text()); });
  page.on('request', r => {
    const u = new URL(r.url());
    if (!['blob:', 'data:'].includes(u.protocol) && u.origin !== ORIGIN) w.outside.push(r.url());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  await page.goto('./');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  return w;
}

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

/**
 * Chrome reports a violation for every inline event handler or style it parses, even into an inert
 * document that never runs them (Firefox does not), and for a <base> element in such a document. Those
 * reports are expected when hostile HTML is parsed for sanitizing; anything else (a script, a connection, a
 * worker, an image from elsewhere) is not.
 */
export async function unexpectedViolations(page: Page): Promise<string[]> {
  return (await cspViolations(page)).filter(v => !/^((script-src-attr|style-src-attr|style-src-elem) inline|base-uri .*)$/.test(v));
}

export interface FilePayload { name: string; mimeType: string; buffer: Buffer }

/** The Markdown sample. The repository keeps no .md files besides README and CHANGELOG, so it is stored as .txt. */
export const MD_SAMPLE: FilePayload = { name: 'sample.md', mimeType: 'text/markdown', buffer: readFileSync(fx('document/markdown-sample.txt')) };

export async function addFiles(page: Page, files: Array<string | FilePayload>): Promise<void> {
  if (files.every(f => typeof f === 'string')) return page.locator('#picker').setInputFiles(files as string[]);
  await page.locator('#picker').setInputFiles(files.map(f => typeof f === 'string'
    ? { name: basename(f), mimeType: 'application/octet-stream', buffer: readFileSync(f) }
    : f));
}

export const row = (page: Page, name: string) => page.locator('li.job', { has: page.locator('.job-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** Waits until a row has finished checking and is ready (or cannot be converted). */
export async function ready(page: Page, name: string): Promise<void> {
  await expect(row(page, name)).toHaveClass(/\b(ready|unsupported|done|failed|canceled)\b/, { timeout: 60_000 });
}

export async function setTarget(page: Page, name: string, label: string): Promise<void> {
  await ready(page, name);
  await row(page, name).getByRole('combobox', { name: new RegExp(`^Convert .* to$`) }).selectOption({ label });
}

/** Converts one file and waits for the result. Returns the row. */
export async function convert(page: Page, name: string, label: string, timeout = 90_000) {
  await setTarget(page, name, label);
  const r = row(page, name);
  const before = Number(await r.getAttribute('data-runs'));
  await r.getByRole('button', { name: /^(Convert|Try again|Convert again|Convert to .+)$/ }).click();
  await expect(r).toHaveAttribute('data-runs', String(before + 1), { timeout });
  return r;
}

export async function expectDone(page: Page, name: string): Promise<void> {
  const r = row(page, name);
  const cls = await r.getAttribute('class');
  if (!/\bdone\b/.test(cls ?? '')) throw new Error(`${name} did not convert: ${await r.locator('.job-error').textContent().catch(() => '(no message)')}`);
}

/** Clicks a result's download button and saves the file. */
export async function download(page: Page, name: string, testInfo: TestInfo, index = 0): Promise<{ path: string; filename: string }> {
  const r = row(page, name);
  const [dl] = await Promise.all([page.waitForEvent('download'), r.locator('.outputs button').nth(index).click()]);
  return save(dl, testInfo);
}

let saved = 0;

export async function save(dl: Download, testInfo: TestInfo): Promise<{ path: string; filename: string }> {
  const filename = dl.suggestedFilename();
  const path = testInfo.outputPath(`${++saved}-${filename}`);
  await dl.saveAs(path);
  return { path, filename };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fileconvert-'));
}

export function ffprobe(path: string): { format: Record<string, string>; streams: Array<Record<string, unknown>> } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** Decodes every frame and every sample with FFmpeg; throws if the file has errors. */
export function ffdecode(path: string): string {
  return execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface PilInfo { format: string; mode: string; size: [number, number]; frames: number; alpha: [number, number] | null; exif: number[]; px: number[][] }

/** EXIF tags that identify a camera, a time or a place. TIFF structure tags are not metadata. */
export const PERSONAL_EXIF = [271, 272, 305, 306, 315, 36867, 34853, 0x8769];

/** Opens an image with Pillow (and pillow-heif), decodes it fully, and samples pixels as RGBA at the given points. */
export function pillow(path: string, points: Array<[number, number]> = []): PilInfo {
  const script = [
    'import sys, json',
    'from PIL import Image',
    'import pillow_heif; pillow_heif.register_heif_opener()',
    'im = Image.open(sys.argv[1]); fmt = im.format; frames = getattr(im, "n_frames", 1); exif = sorted(im.getexif().keys())',
    'im.load(); rgba = im.convert("RGBA")',
    'has_a = "A" in im.getbands() or "transparency" in im.info',
    'pts = json.loads(sys.argv[2])',
    'print(json.dumps({"format": fmt, "mode": im.mode, "size": list(im.size), "frames": frames, "alpha": list(rgba.getchannel("A").getextrema()) if has_a else None, "exif": exif, "px": [list(rgba.getpixel((x, y))) for x, y in pts]}))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path, JSON.stringify(points)], { encoding: 'utf8' }));
}

export const near = (a: number[], b: number[], tol: number) => a.slice(0, b.length).every((v, i) => Math.abs(v - b[i]) <= tol);

/** Text of a PDF read by Xpdf's pdftotext, an independent reader; -layout keeps each line as set. */
export function pdftotext(path: string, layout = true): string {
  const out = path + '.txt';
  execFileSync('pdftotext', [...(layout ? ['-layout'] : []), '-enc', 'UTF-8', path, out]);
  return readFileSync(out, 'utf8');
}

export function bytes(path: string): Buffer {
  return readFileSync(path);
}

/** Sets every file to one output with "Set all to", converts them all, and waits until none is pending. */
export async function convertAllTo(page: Page, label: string, timeout = 180_000): Promise<void> {
  const n = await page.locator('li.job').count();
  for (let i = 0; i < n; i++) await expect(page.locator('li.job').nth(i)).not.toHaveClass(/\bchecking\b/, { timeout: 60_000 });
  const option = page.locator('#bulk-target option', { hasText: new RegExp(`^${label}( \\(|$)`) });
  await page.locator('#bulk-target').selectOption({ label: (await option.first().textContent())! });
  await page.locator('#convert-all').click();
  await expect(page.locator('li.job.queued, li.job.converting')).toHaveCount(0, { timeout });
}

/** Downloads the batch ZIP and returns its entries. */
export async function downloadZip(page: Page, testInfo: TestInfo): Promise<{ name: string; entries: Record<string, Uint8Array>; path: string }> {
  const { unzipSync } = await import('fflate');
  await expect(page.locator('#zip')).toBeEnabled();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#zip').click()]);
  const { path, filename } = await save(dl, testInfo);
  return { name: filename, entries: unzipSync(new Uint8Array(readFileSync(path))), path };
}

export function writeTemp(dir: string, name: string, data: Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

/** Reads a document or data result with Python's own readers (tests/e2e/readers.py), never with FileConvert's code. */
export function pyRead<T = unknown>(kind: 'csv' | 'tsv' | 'json' | 'jsonl' | 'xlsx' | 'docx' | 'md', path: string): T {
  return JSON.parse(execFileSync(PYTHON, ['-I', resolve('tests/e2e/readers.py'), kind, path], { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

/** LibreOffice, an independent office suite, for reading DOCX results: it converts a file and returns the new path. */
export function libreoffice(path: string, to: string): string {
  const soffice = process.env.FILECONVERT_SOFFICE || (existsSync('C:/Program Files/LibreOffice/program/soffice.exe') ? 'C:/Program Files/LibreOffice/program/soffice.exe' : 'soffice');
  const out = tempDir();
  // A private profile, so a LibreOffice the user has open is not disturbed.
  const profile = pathToFileURL(tempDir()).href;
  execFileSync(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', to, '--outdir', out, path], { stdio: 'pipe', timeout: 180_000 });
  const made = readdirSync(out);
  if (made.length !== 1) throw new Error(`LibreOffice did not convert ${path}`);
  return join(out, made[0]);
}
