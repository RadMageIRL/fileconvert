// Conversion settings, one group per category, remembered in this browser (localStorage) as a convenience.
// Nothing about files is stored, only these choices.

import { DEFAULT_DATA_OPTIONS, type DataOptions } from '../engines/data/options';
import type { ResizeMode } from '../engines/image/convert';
import type { QualityLevel } from 'mediabunny';

export interface Settings {
  image: { quality: number; resize: ResizeMode; background: string };
  audio: { bitrate: number; sampleRate: number; channels: number };
  video: { maxHeight: number; quality: 'original' | QualityLevel; removeAudio: boolean; gifWidth: number; gifFps: number };
  document: { pageSize: 'LETTER' | 'A4'; fontSize: number };
  data: Omit<DataOptions, 'sheet'>;
}

const usLetter = () => {
  const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  return /^(en-(US|CA|PH)|es-(MX|US|CO|VE|PR|GT|CL)|fr-CA)$/i.test(lang);
};

export function defaultSettings(): Settings {
  const { sheet: _sheet, ...data } = DEFAULT_DATA_OPTIONS;
  void _sheet;
  return {
    image: { quality: 85, resize: { mode: 'none' }, background: '#ffffff' },
    audio: { bitrate: 0, sampleRate: 0, channels: 0 },
    video: { maxHeight: 0, quality: 'original', removeAudio: false, gifWidth: 480, gifFps: 10 },
    document: { pageSize: usLetter() ? 'LETTER' : 'A4', fontSize: 10 },
    data,
  };
}

const KEY = 'fileconvert-settings-v1';

export function loadSettings(): Settings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Settings>;
    // Only known keys with the right types are taken, so an old or edited value cannot break the page.
    const merge = <T extends object>(def: T, val: unknown): T => {
      if (!val || typeof val !== 'object') return def;
      const out = { ...def } as Record<string, unknown>;
      for (const [k, v] of Object.entries(def)) {
        const s = (val as Record<string, unknown>)[k];
        if (s !== undefined && typeof s === typeof v && (typeof v !== 'object' || v === null)) out[k] = s;
      }
      return out as T;
    };
    const r = (saved.image?.resize ?? base.image.resize) as ResizeMode;
    const resize: ResizeMode = r.mode === 'percent' && typeof r.percent === 'number' ? { mode: 'percent', percent: r.percent }
      : r.mode === 'fit' && typeof r.width === 'number' && typeof r.height === 'number' ? { mode: 'fit', width: r.width, height: r.height }
      : { mode: 'none' };
    const s: Settings = {
      image: { ...merge(base.image, saved.image), resize },
      audio: merge(base.audio, saved.audio),
      video: merge(base.video, saved.video),
      document: merge(base.document, saved.document),
      data: merge(base.data, saved.data),
    };
    const oneOf = <T>(v: T, allowed: readonly T[], def: T) => allowed.includes(v) ? v : def;
    s.image.quality = Math.max(1, Math.min(100, Math.round(s.image.quality) || 85));
    if (!/^#[0-9a-f]{6}$/i.test(s.image.background)) s.image.background = base.image.background;
    s.audio.bitrate = oneOf(s.audio.bitrate, [0, 96, 128, 160, 192, 256, 320], 0);
    s.audio.sampleRate = oneOf(s.audio.sampleRate, [0, 44100, 48000], 0);
    s.audio.channels = oneOf(s.audio.channels, [0, 1, 2], 0);
    s.video.maxHeight = oneOf(s.video.maxHeight, [0, 2160, 1440, 1080, 720, 480, 360], 0);
    s.video.quality = oneOf(s.video.quality, ['original', 'very-high', 'high', 'medium', 'low', 'very-low'] as const, 'original');
    s.video.gifWidth = oneOf(s.video.gifWidth, [320, 480, 640, 800], 480);
    s.video.gifFps = oneOf(s.video.gifFps, [5, 10, 15, 20], 10);
    s.document.pageSize = oneOf(s.document.pageSize, ['LETTER', 'A4'] as const, base.document.pageSize);
    s.document.fontSize = oneOf(s.document.fontSize, [9, 10, 11, 12], 10);
    s.data.delimiter = oneOf(s.data.delimiter, [',', ';', '\t'] as const, ',');
    s.data.inputDelimiter = oneOf(s.data.inputDelimiter, ['auto', ',', ';', '\t', '|'] as const, 'auto');
    s.data.arrays = oneOf(s.data.arrays, ['json', 'columns'] as const, 'json');
    s.data.values = oneOf(s.data.values, ['formatted', 'raw'] as const, 'formatted');
    return s;
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: settings last for this visit */ }
}
