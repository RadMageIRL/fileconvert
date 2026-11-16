import { App } from './app/ui';
import { $ } from './app/dom';
import { loadSettings } from './app/settings';
import { hasTempStore, openSession } from './core/tempstore';
import { VERSION } from './version';

/** The address Share passes on: always the public one, whichever copy of the page is open. */
const SHARE = Object.freeze({
  title: 'FileConvert',
  text: 'A free, private file converter: images, audio, video, documents and data, converted in your browser.',
  url: 'https://radmagelabs.com/fileconvert/',
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

async function main(): Promise<void> {
  $('version').textContent = `v${VERSION}`;
  setupTheme();
  const session = hasTempStore() ? await openSession().catch(() => null) : null;
  const app = new App(loadSettings(), session);
  setupShare(app);
  app.start();
  Object.defineProperty(window, '__fileconvert', { value: app, enumerable: false });
  document.documentElement.dataset.ready = 'true';
}

void main();
