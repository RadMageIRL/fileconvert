// Repository rules, checked mechanically.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import pkg from '../../package.json';

const root = join(__dirname, '..', '..');
/** Files git would commit: tracked, plus untracked ones that are not ignored or excluded. */
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const TEXT = /\.(ts|mjs|js|json|html|css|md|txt|yml|yaml|svg|py|csv|xml)$|^LICENSE$|^\.gitignore$/;
const read = (f: string) => readFileSync(join(root, f), 'utf8');

describe('house rules', () => {
  test('only README.md and CHANGELOG.md are Markdown files in the repository', () => {
    expect(files.filter(f => f.endsWith('.md'))).toEqual(['CHANGELOG.md', 'README.md']);
  });

  test('no em dashes anywhere in the repository', () => {
    const offenders = files.filter(f => TEXT.test(f) && read(f).includes('\u2014'));
    expect(offenders).toEqual([]);
  });

  test('source code is plain ASCII (escapes, not raw characters)', () => {
    // Test fixtures hold real UTF-8 text on purpose.
    const offenders = files.filter(f => /\.(ts|mjs|js|css|html)$/.test(f) && !f.startsWith('tests/fixtures/') && /[^\x09\x0a\x0d\x20-\x7e]/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  test('the app names no outside host except RadMage Labs, its source code, and standard namespaces', () => {
    const allowed = /^https:\/\/(radmagelabs\.com\/|github\.com\/RadMageIRL\/fileconvert|schema\.org)|^http:\/\/www\.w3\.org\//;
    const found: string[] = [];
    for (const f of files.filter(f => /^src\/|^index\.html$/.test(f))) {
      for (const m of read(f).matchAll(/https?:\/\/[^\s'"`)<>]+/g)) if (!allowed.test(m[0])) found.push(`${f}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  test('the page names its canonical address and a link-preview image with a description', () => {
    const html = read('index.html');
    expect(html).toContain('<link rel="canonical" href="https://radmagelabs.com/fileconvert/">');
    expect(html).toContain('<meta property="og:image" content="https://radmagelabs.com/assets/og/fileconvert.png">');
    expect(html).toMatch(/<meta property="og:image:alt" content="FileConvert [^"]{20,}">/);
  });

  test('no build output, caches or local files are committed', () => {
    expect(files.filter(f => /^(dist|node_modules|local|test-results|playwright-report|release)\//.test(f))).toEqual([]);
    expect(files.filter(f => /(^|\/)\.env(\.|$)/.test(f))).toEqual([]);
  });

  test('the version is the same in package.json, the changelog and the README', () => {
    expect(read('CHANGELOG.md')).toMatch(new RegExp(`^## v${pkg.version.replace(/\./g, '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    expect(read('README.md')).toContain(`Current version: **v${pkg.version}**`);
  });

  test('the license is MIT, and the notices are present', () => {
    expect(pkg.license).toBe('MIT');
    expect(read('LICENSE')).toMatch(/^MIT License/);
    expect(read('THIRD-PARTY-NOTICES.txt')).toMatch(/^Bundled packages: /m);
  });
});
