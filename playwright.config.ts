import { defineConfig, devices } from '@playwright/test';

// Browser tests run against the production build in dist/, served the way radmagelabs.com serves it.
// `npm run build` first. Chrome and Edge are the installed browsers; Firefox and WebKit are Playwright's.
// FILECONVERT_BASE=https://radmagelabs.com/fileconvert/ runs the same tests against a live copy instead.
const live = process.env.FILECONVERT_BASE;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: live || 'http://127.0.0.1:4175/fileconvert/',
    acceptDownloads: true,
    trace: 'off',
  },
  webServer: live ? undefined : {
    command: 'node tools/serve.mjs --port 4175',
    url: 'http://127.0.0.1:4175/fileconvert/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, testIgnore: ['**/webkit.spec.ts', '**/large*.spec.ts'] },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: ['**/webkit.spec.ts', '**/large*.spec.ts'] },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' }, testIgnore: ['**/webkit.spec.ts', '**/large*.spec.ts'] },
    // Playwright's WebKit on Windows lacks OffscreenCanvas and WebCodecs, so it gets its own checks.
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: ['**/webkit.spec.ts'] },
    // A phone-sized Chrome: layout, touch-sized controls and a real conversion.
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, testMatch: ['**/smoke.spec.ts', '**/app.spec.ts', '**/pages.spec.ts', '**/catalog.spec.ts', '**/pdf-merge.spec.ts', '**/pdf-pages.spec.ts'] },
    // Large files, run on request: npx playwright test --project large
    { name: 'large', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, testMatch: ['**/large.spec.ts', '**/large-pdf.spec.ts'], timeout: 900_000 },
  ],
});
