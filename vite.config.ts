/// <reference types="vitest/config" />
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { ALIASES, pageBySlug, PAGES } from './src/core/pages.ts';
import { fillStatics, pageProblems, render404, renderAlias, renderPage, sitemapXml, stripMarkers } from './src/site/render.ts';
import { CSP } from './tools/csp.mjs';

const PDFJS = join('node_modules', 'pdfjs-dist');
/** pdf.js's files for drawing pages, served from the app's folder: the standard fonts, the JPEG 2000 and JBIG2 decoders
 *  and the color management module (WebAssembly), and its CMYK profile. Not the JavaScript sandbox (quickjs), which
 *  runs PDF scripts, nor the decoders' JavaScript fallbacks, for browsers without WebAssembly. */
const PDFJS_FILES: Record<string, RegExp> = {
  cmaps: /^[\w.-]+\.bcmap$/,
  standard_fonts: /^Foxit\w+\.pfb$/,
  wasm: /^(openjpeg|jbig2|qcms_bg)\.wasm$/,
  iccs: /^[\w.-]+\.icc$/,
};
/** The sans-serif standard font, from vendor/arimo (Apache-2.0) in place of the Liberation Sans files pdfjs-dist ships:
 *  served beside pdf.js's other standard fonts, where the render worker asks for it by Liberation Sans's names
 *  (src/engines/pdf/render.ts). */
const ARIMO = join('vendor', 'arimo');
const ARIMO_FILES = /^Arimo-(Regular|Bold|Italic|BoldItalic)\.ttf$/;

/**
 * Adds the Content-Security-Policy to the built page as a meta tag, for hosts that cannot send headers
 * (GitHub Pages, a local copy). radmagelabs.com sends the same policy as a header, plus frame-ancestors.
 * The page has no inline scripts, so the policy is identical in both places; the build fails if one appears.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'fileconvert-csp',
    apply: 'build',
    transformIndexHtml(html) {
      for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
        if (!/\bsrc=/.test(m[1]) && !/type="application\/ld\+json"/.test(m[1])) {
          throw new Error('index.html has an inline script. Move it to a file so the Content-Security-Policy stays free of hashes.');
        }
      }
      return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

/**
 * pdf.js needs its character maps to read text from PDFs that use CID fonts (most Chinese, Japanese and
 * Korean PDFs), and to draw pages the files in PDFJS_FILES. They are copied next to the app, served in development,
 * and fetched only when a PDF needs one.
 */
function pdfjsCmaps(): Plugin {
  return {
    name: 'fileconvert-pdfjs-cmaps',
    configureServer(server) {
      for (const [dir, ok] of Object.entries(PDFJS_FILES)) {
        server.middlewares.use(`/pdfjs/${dir}/`, (req, res, next) => {
          const name = (req.url ?? '').replace(/^\/+/, '').split('?')[0];
          const arimo = dir === 'standard_fonts' && ARIMO_FILES.test(name);
          if (!ok.test(name) && !arimo) return next();
          res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
          res.end(readFileSync(arimo ? join(ARIMO, name) : join(PDFJS, dir, name)));
        });
      }
    },
    generateBundle() {
      for (const [dir, ok] of Object.entries(PDFJS_FILES)) {
        for (const name of readdirSync(join(PDFJS, dir)).filter(n => ok.test(n)).sort()) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(PDFJS, dir, name)) });
        }
      }
      for (const name of readdirSync(ARIMO).filter(n => ARIMO_FILES.test(n)).sort()) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/standard_fonts/${name}`, source: readFileSync(join(ARIMO, name)) });
      }
    },
  };
}

/**
 * Records every npm package whose code or files end up in the build (the page, every worker, and assets
 * such as fonts and WebAssembly). THIRD-PARTY-NOTICES.txt must cover exactly that set: the build fails if
 * it does not, and `npm run notices` rewrites the file from it.
 */
const bundled = new Set<string>();
const packageOf = (id: string) => {
  const parts = id.split(/[\\/]node_modules[\\/]/);
  if (parts.length < 2) return null;
  const rest = parts[parts.length - 1].split(/[\\/]/);
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
};
function bundledPackages(main: boolean): Plugin {
  return {
    name: 'fileconvert-bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const out of Object.values(bundle)) {
        const ids = out.type === 'chunk' ? (out.moduleIds ?? Object.keys(out.modules)) : (out.originalFileNames ?? []);
        for (const id of ids) {
          const name = packageOf(id.replace(/^\0/, ''));
          if (name) bundled.add(name);
        }
      }
      if (main) bundled.add('pdfjs-dist'); // the character maps, emitted by pdfjsCmaps()
    },
    closeBundle() {
      if (!main) return;
      const list = [...bundled].sort();
      if (process.env.FILECONVERT_PACKAGES_OUT) {
        writeFileSync(process.env.FILECONVERT_PACKAGES_OUT, JSON.stringify(list, null, 2));
        return;
      }
      const notices = readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8');
      const line = /^Bundled packages: (.*)$/m.exec(notices)?.[1] ?? '';
      const listed = line.split(', ').map(s => s.replace(/@[^@]+$/, '')).filter(Boolean).sort();
      if (listed.join(',') !== list.join(',')) {
        throw new Error(`THIRD-PARTY-NOTICES.txt is out of date. Bundled: ${list.join(', ')}. Run npm run notices.`);
      }
    },
  };
}

/**
 * The site's pages. index.html is filled with its static content (catalog, formats, limits), and every page in
 * src/core/pages.ts is rendered from the built index.html into <slug>/index.html, so all pages share the same
 * hashed scripts, styles and security policy. Also writes sitemap.xml (canonical radmagelabs.com addresses) and
 * 404.html. The build fails if a page names a conversion that does not exist or repeats a title or description.
 */
function sitePages(): Plugin {
  const lastmod = () => {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
    return new RegExp(`^## v${version.replace(/\./g, '\\.')} - (\\d{4}-\\d{2}-\\d{2})$`, 'm').exec(readFileSync('CHANGELOG.md', 'utf8'))?.[1] ?? null;
  };
  return {
    name: 'fileconvert-pages',
    enforce: 'post',
    buildStart() {
      const problems = pageProblems();
      if (problems.length) throw new Error(`The page list has problems:\n${problems.join('\n')}`);
    },
    transformIndexHtml: { order: 'pre', handler: html => fillStatics(html) },
    configureServer(server) {
      // Development: /<slug>/ serves that page, rendered from index.html like the build does.
      server.middlewares.use(async (req, res, next) => {
        const slug = /^\/([a-z0-9-]+)\/$/.exec((req.url ?? '').split('?')[0])?.[1];
        if (slug && ALIASES[slug]) { res.statusCode = 308; res.setHeader('Location', `/${ALIASES[slug]}/`); res.end(); return; }
        const page = slug ? pageBySlug(slug) : undefined;
        if (!page) return next();
        const home = await server.transformIndexHtml('/', readFileSync('index.html', 'utf8'));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(stripMarkers(renderPage(home, page)));
      });
    },
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') throw new Error('index.html is missing from the build.');
      const home = String(index.source);
      for (const page of PAGES) {
        this.emitFile({ type: 'asset', fileName: `${page.slug}/index.html`, source: stripMarkers(renderPage(home, page)) });
      }
      for (const from of Object.keys(ALIASES)) this.emitFile({ type: 'asset', fileName: `${from}/index.html`, source: renderAlias(home, from) });
      this.emitFile({ type: 'asset', fileName: '404.html', source: stripMarkers(render404(home)) });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(lastmod()) });
      index.source = stripMarkers(home);
    },
  };
}

/** The license and the third-party notices travel with the app, since minified bundles drop license comments. */
function licenseFiles(): Plugin {
  return {
    name: 'fileconvert-license-files',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: readFileSync('LICENSE', 'utf8') });
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8') });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [contentSecurityPolicy(), pdfjsCmaps(), licenseFiles(), sitePages(), bundledPackages(true)],
  worker: { format: 'es', plugins: () => [bundledPackages(false)] },
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    modulePreload: { polyfill: false },
  },
  server: { port: 5173, strictPort: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
