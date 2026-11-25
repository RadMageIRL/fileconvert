import { App } from './app/ui';
import { setupCatalog } from './app/catalog';
import { $ } from './app/dom';
import { FORMATS, type FormatId } from './core/formats';
import { isToolId } from './core/tools';
import { loadSettings } from './app/settings';
import { hasTempStore, openSession } from './core/tempstore';
import { VERSION } from './version';

/**
 * The address Share passes on: always the public one, whichever copy of the page is open. It is the page's
 * canonical address, so a conversion page shares itself.
 */
const SHARE = Object.freeze({
  title: 'FileConvert',
  text: 'A free, private file converter: images, audio, video, documents and data, converted in your browser.',
  url: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || 'https://radmagelabs.com/fileconvert/',
});

function setupTheme(): void {
  const btn = $<HTMLButtonElement>('theme');
  const label = $('theme-label');
  const apply = (t: 'dark' | 'light') => {
    document.documentElement.dataset.theme = t;
    btn.setAttribute('aria-pressed', String(t === 'light'));
    label.textContent = t === 'dark' ? 'Light theme' : 'Dark theme';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#10151f' : '#f4f6f9');
  };
  apply(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    apply(next);
    try { localStorage.setItem('fileconvert-theme', next); } catch { /* storage unavailable */ }
  });
}

function setupShare(app: App): void {
  $('share').addEventListener('click', async () => {
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && (!nav.canShare || nav.canShare(SHARE))) {
      try {
        await nav.share(SHARE);
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(SHARE.url);
      app.toast(`Link copied: ${SHARE.url}`);
    } catch {
      app.toast(`Share this address: ${SHARE.url}`, 10000);
    }
  });
}

/** The privacy notes open from a pill in the footer, into a panel just above it. */
function setupPrivacy(): void {
  const pill = $<HTMLButtonElement>('privacy-pill');
  const panel = $('privacy');
  const foot = pill.closest('footer')!;
  const isOpen = () => pill.getAttribute('aria-expanded') === 'true';
  const set = (open: boolean) => {
    panel.hidden = !open;
    pill.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // Show the whole panel with the footer under it, or the panel's top when both do not fit.
    const top = panel.getBoundingClientRect().top;
    const bottom = foot.getBoundingClientRect().bottom;
    if (top < 0 || bottom > window.innerHeight) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollBy({ top: Math.min(top, bottom - window.innerHeight), behavior: smooth ? 'smooth' : 'auto' });
    }
  };
  pill.addEventListener('click', () => set(!isOpen()));
  $('privacy-close').addEventListener('click', () => { set(false); pill.focus(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isOpen()) return;
    const inside = panel.contains(document.activeElement);
    set(false);
    if (inside) pill.focus();
  });
}

async function main(): Promise<void> {
  $('version').textContent = `v${VERSION}`;
  setupTheme();
  setupPrivacy();
  const session = hasTempStore() ? await openSession().catch(() => null) : null;
  const app = new App(loadSettings(), session);
  // A conversion page (data-to="jpg" on /heic-to-jpg/) chooses its output for every file that offers it.
  const to = document.documentElement.dataset.to;
  if (to && to in FORMATS) app.queue.preferredTarget = to as FormatId;
  setupShare(app);
  setupCatalog();
  app.start();
  // A tool page (data-tool on /remove-image-metadata/) opens its tool in place of the converter.
  const tool = document.documentElement.dataset.tool;
  // A page about one use of a tool (data-preset="format=png" on /pdf-to-png/) sets that option.
  const preset = Object.fromEntries(new URLSearchParams(document.documentElement.dataset.preset ?? ''));
  if (tool && isToolId(tool)) await app.openTool(tool, preset);
  Object.defineProperty(window, '__fileconvert', { value: app, enumerable: false });
  document.documentElement.dataset.ready = 'true';
}

void main();
