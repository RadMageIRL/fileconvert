// The conversion queue. Each added file becomes a job: it is sniffed, inspected (media tracks, animation,
// worksheets), offered the outputs that make sense for it, and converted on request by the right engine.
// Results get unique, safe names. Nothing here talks to the network.

import { engineFor, FORMATS, targetsFor, WORKBOOKS, type FormatId, type InputTraits } from '../core/formats';
import { formatBytes, LIMITS } from '../core/limits';
import { isLoadFailure, loadFailureMessage } from '../core/loading';
import { NameRegistry, safeBase } from '../core/naming';
import { sniffBlob, type Sniffed } from '../core/sniff';
import { deleteTempFile, deleteTempPrefix } from '../core/tempstore';
import type { ExtractResult, Extracted, Skipped } from '../engines/archive/extract';
import type { DataResult } from '../engines/data/options';
import type { FontFile } from '../engines/document/fonts';
import { readHeader } from '../engines/image/header';
import type { ImageResult } from '../engines/image/convert';
import type { SvgSize } from '../engines/image/svg';
import type { MediaInfo, MediaResult } from '../engines/media/convert';
import { CanceledError, Pool } from './pool';
import type { Settings } from './settings';

export type JobStatus = 'checking' | 'ready' | 'queued' | 'converting' | 'done' | 'failed' | 'canceled' | 'unsupported';

export interface JobOutput {
  name: string;
  blob: Blob;
  /** Name of the temporary OPFS file holding the blob, if any. */
  temp?: string;
}

export interface Job {
  id: number;
  file: File;
  name: string;
  sniffed?: Sniffed;
  format: FormatId | null;
  traits: InputTraits;
  /** One line about the input: "JPEG image, 2.1 MB, 4032 x 3024". */
  info: string;
  notes: string[];
  targets: FormatId[];
  target: FormatId | null;
  sheets?: string[];
  sheet: 'first' | 'all' | string;
  status: JobStatus;
  fraction?: number;
  stage?: string;
  error?: string;
  warnings: string[];
  summary?: string;
  outputs: JobOutput[];
  /** Target the current outputs were made for. */
  madeAs?: FormatId;
  /** The output name reserved when the conversion was requested, so names follow the list order. */
  reserved?: string;
  controller?: AbortController;
  startedAt?: number;
  /** Conversions finished so far (done, failed or canceled), shown on the row for the tests. */
  runs: number;
  /** An archive's unpacked files, each with the format found in its bytes (null when it cannot be converted). */
  archive?: { entries: ArchiveEntry[]; skipped: Skipped[] };
  /** Temporary files of an unpacked archive, by name prefix. */
  tempPrefix?: string;
  /** The archive a file was taken from, by job id: its temporary files must outlive this job. */
  parent?: number;
}

export interface ArchiveEntry extends Extracted {
  format: FormatId | null;
  label: string;
}

// Each Worker is created with the URL written inline, the form the bundler recognizes and builds.
export class Engines {
  image = new Pool(() => new Worker(new URL('../workers/image.worker.ts', import.meta.url), { type: 'module' }), 2);
  media = new Pool(() => new Worker(new URL('../workers/media.worker.ts', import.meta.url), { type: 'module' }), 1);
  inspect = new Pool(() => new Worker(new URL('../workers/media.worker.ts', import.meta.url), { type: 'module' }), 1);
  document = new Pool(() => new Worker(new URL('../workers/document.worker.ts', import.meta.url), { type: 'module' }), 1);
  data = new Pool(() => new Worker(new URL('../workers/data.worker.ts', import.meta.url), { type: 'module' }), 1);
  archive = new Pool(() => new Worker(new URL('../workers/zip.worker.ts', import.meta.url), { type: 'module' }), 1);
  all(): Pool[] { return [this.image, this.media, this.inspect, this.document, this.data, this.archive]; }
}

/**
 * Browser features a category needs. Pictures are drawn on an OffscreenCanvas in a worker; audio and video
 * are decoded and encoded with WebCodecs. A browser without them gets a clear reason instead of a failure.
 */
export function missingCapability(category: string): string | null {
  const g = globalThis as Record<string, unknown>;
  if (category === 'image' && typeof g.OffscreenCanvas !== 'function') {
    return 'Converting pictures needs OffscreenCanvas, which this browser does not have. Current Chrome, Edge, Firefox and Safari (16.4 and later) have it.';
  }
  if ((category === 'audio' || category === 'video') && (typeof g.AudioDecoder !== 'function' || typeof g.VideoDecoder !== 'function' || typeof g.OffscreenCanvas !== 'function')) {
    return 'Converting audio and video needs WebCodecs, which this browser does not have. Current Chrome, Edge and Firefox have it.';
  }
  return null;
}

const fmtDuration = (s: number) => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

export class Queue {
  jobs: Job[] = [];
  /** The output a dedicated page is about (JPG on the HEIC to JPG page): chosen first for every file that offers it. */
  preferredTarget: FormatId | null = null;
  private names = new NameRegistry();
  private nextId = 1;
  /** Limits on conversions running at once, per engine family. */
  private running = new Map<string, number>();
  private pending: Job[] = [];

  constructor(
    private engines: Engines,
    private getSettings: () => Settings,
    private session: string | null,
    private onChange: (job: Job) => void,
    private onListChange: () => void,
  ) {}

  add(files: Iterable<File>): Job[] {
    const added: Job[] = [];
    for (const file of files) {
      const job: Job = {
        id: this.nextId++, file, name: file.name || 'unnamed', format: null, traits: {}, info: formatBytes(file.size), notes: [],
        targets: [], target: null, sheet: 'first', status: 'checking', warnings: [], outputs: [], runs: 0,
      };
      this.jobs.push(job);
      added.push(job);
      void this.inspect(job);
    }
    this.onListChange();
    return added;
  }

  private async inspect(job: Job): Promise<void> {
    try {
      const s = await sniffBlob(job.file, job.name);
      job.sniffed = s;
      job.format = s.format;
      if (s.mismatch) job.notes.push(s.mismatch);
      if (!s.format) {
        job.status = 'unsupported';
        job.info = `${s.label}, ${formatBytes(job.file.size)}`;
        job.error = s.reason;
        this.onChange(job);
        return;
      }
      const fmt = FORMATS[s.format];
      const parts = [s.label, formatBytes(job.file.size)];
      if (fmt.category === 'archive') {
        // An archive is unpacked, not converted: its row offers Extract files instead of a list of formats.
        job.info = parts.join(', ');
        job.notes.push('An archive: FileConvert unpacks it so its files can be downloaded or converted, but does not turn one archive format into another.');
        job.status = 'ready';
        this.onChange(job);
        return;
      }
      const missing = missingCapability(fmt.category);
      if (missing) {
        job.status = 'unsupported';
        job.info = parts.join(', ');
        job.error = missing;
        this.onChange(job);
        return;
      }
      if (fmt.category === 'image') {
        const head = new Uint8Array(await job.file.slice(0, s.format === 'gif' ? 4 * 1048576 : 256 * 1024).arrayBuffer());
        const h = readHeader(head, s.format);
        if (h.width && h.height) parts.push(`${h.width} x ${h.height}`);
        if (h.animated) {
          parts.push(h.frames ? `animated, ${h.frames} frames` : 'animated');
          // Animated WebP and APNG frames come from ImageDecoder; without it they convert as their first frame.
          if (s.format === 'gif' || typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function') job.traits.animated = true;
          else job.notes.push(`This browser cannot read the frames of an animated ${fmt.label}, so it converts as its first frame.`);
        }
      } else if (fmt.category === 'audio' || fmt.category === 'video') {
        const info = await this.engines.inspect.run<MediaInfo>('inspect', { file: job.file, format: s.format });
        job.traits.hasVideo = !!info.video;
        job.traits.hasAudio = !!info.audio;
        if (info.duration) parts.push(fmtDuration(info.duration));
        if (info.video) parts.push(`${info.video.width} x ${info.video.height} ${codec(info.video.codec)}`);
        if (info.audio) parts.push(`${codec(info.audio.codec)} audio`);
        if (info.video && !info.video.decodable) {
          job.status = 'unsupported';
          job.info = parts.join(', ');
          job.error = `The video is ${codec(info.video.codec)}, which this browser cannot decode.${info.video.codec === 'hevc' ? ' HEVC decoding depends on the browser and hardware; Chrome and Edge on recent Windows and macOS usually have it, Firefox does not.' : ''}`;
          if (info.audio?.decodable) {
            // The audio can still be extracted.
            job.status = 'ready';
            job.traits.hasVideo = false;
            job.notes.push(`${job.error} Only the audio can be converted.`);
            job.error = undefined;
          } else {
            this.onChange(job);
            return;
          }
        }
        if (!info.video && info.audio && !info.audio.decodable) {
          job.status = 'unsupported';
          job.info = parts.join(', ');
          job.error = `The audio is ${codec(info.audio.codec)}, which this browser cannot decode.`;
          this.onChange(job);
          return;
        }
        if (!info.video && !info.audio) {
          job.status = 'unsupported';
          job.info = parts.join(', ');
          job.error = 'The file has no audio or video track that FileConvert can read.';
          this.onChange(job);
          return;
        }
        if (info.video && info.audio && !info.audio.decodable) {
          job.traits.hasAudio = false;
          job.notes.push(`The audio is ${codec(info.audio.codec)}, which this browser cannot decode; only the video can be converted, without sound.`);
        }
        if (info.audioTracks > 1) job.notes.push(`${info.audioTracks} audio tracks; the first is converted.`);
        if (info.unreadableVideo) {
          // A transport stream whose video Mediabunny cannot read at all, such as MPEG-2 from a TV recording.
          if (!info.audio?.decodable) {
            job.status = 'unsupported';
            job.info = parts.join(', ');
            job.error = `The video is ${info.unreadableVideo}, which FileConvert cannot decode (TV recordings and DVDs often use it), and there is no sound it can read.`;
            this.onChange(job);
            return;
          }
          job.notes.push(`The video is ${info.unreadableVideo}, which FileConvert cannot decode (TV recordings and DVDs often use it). Only the sound can be converted.`);
        }
        job.notes.push(...(info.notes ?? []));
      } else if (WORKBOOKS.includes(s.format)) {
        job.sheets = await this.engines.data.run<string[]>('sheets', { file: job.file, kind: s.format });
        parts.push(`${job.sheets.length} ${job.sheets.length === 1 ? 'sheet' : 'sheets'}`);
      }
      job.info = parts.join(', ');
      job.targets = targetsFor(s.format, job.traits);
      // Animated GIF to video also needs WebCodecs.
      if (fmt.category === 'image' && missingCapability('video')) job.targets = job.targets.filter(t => FORMATS[t].category === 'image');
      if (job.targets.length === 0) {
        job.status = 'unsupported';
        job.error = 'There is nothing FileConvert can convert this file to.';
      } else {
        job.target = this.preferredTarget && job.targets.includes(this.preferredTarget) ? this.preferredTarget : job.targets[0];
        job.status = 'ready';
      }
    } catch (e) {
      job.status = 'unsupported';
      job.error = isLoadFailure(e) ? loadFailureMessage() : (e as Error).message || 'The file could not be read.';
    }
    this.onChange(job);
  }

  setTarget(job: Job, to: FormatId): void {
    if (!job.targets.includes(to)) return;
    job.target = to;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') {
      job.status = 'ready';
      job.error = undefined;
    }
    this.onChange(job);
  }

  /** Queues every job that is ready (or finished with a different output than now chosen). */
  convertAll(): void {
    for (const j of this.jobs) {
      // Archives are unpacked one at a time, on request; Convert all converts.
      if (j.format && FORMATS[j.format].category === 'archive') continue;
      if (j.status === 'ready' || j.status === 'canceled' || j.status === 'failed') this.convert(j);
    }
  }

  convert(job: Job): void {
    if (job.format && FORMATS[job.format].category === 'archive' && (job.status === 'ready' || job.status === 'failed' || job.status === 'canceled')) {
      void this.extract(job);
      return;
    }
    if (!job.format || !job.target || job.status === 'converting' || job.status === 'queued' || job.status === 'checking' || job.status === 'unsupported') return;
    job.status = 'queued';
    job.error = undefined;
    job.fraction = undefined;
    job.stage = undefined;
    job.controller = new AbortController();
    // Reserve the result's name now, in list order, rather than when it finishes. Converting a file again
    // to the same format keeps the name its previous result had.
    const ext = FORMATS[job.target].ext;
    const prev = job.outputs.length === 1 && job.outputs[0].name.toLowerCase().endsWith(`.${ext}`) ? job.outputs[0].name : null;
    job.reserved = prev ?? this.names.claim(safeBase(job.name), ext);
    this.pending.push(job);
    this.onChange(job);
    this.pump();
  }

  cancel(job: Job): void {
    if (job.status === 'converting' && job.format && FORMATS[job.format].category === 'archive') {
      job.controller?.abort();
      return;
    }
    if (job.status === 'queued') {
      this.pending = this.pending.filter(j => j !== job);
      if (job.reserved && !job.outputs.some(o => o.name === job.reserved)) this.names.release(job.reserved);
      job.reserved = undefined;
      job.status = 'canceled';
      this.onChange(job);
    } else if (job.status === 'converting') {
      job.controller?.abort();
    }
  }

  cancelAll(): void {
    for (const j of this.jobs) if (j.status === 'queued' || j.status === 'converting') this.cancel(j);
  }

  remove(job: Job): void {
    this.cancel(job);
    this.dropOutputs(job);
    this.jobs = this.jobs.filter(j => j !== job);
    this.dropArchive(job);
    // A file taken from an archive that was already removed: the archive's files go once none is left.
    if (job.parent !== undefined && !this.jobs.some(j => j.id === job.parent)) {
      const orphans = this.jobs.filter(j => j.parent === job.parent);
      if (!orphans.length && this.session) void deleteTempPrefix(this.session, `arc-${job.parent}-`);
    }
    this.onListChange();
  }

  /** Deletes an archive's unpacked files, unless files taken from it are still in the list. */
  private dropArchive(job: Job): void {
    if (!job.tempPrefix || !this.session) return;
    if (this.jobs.some(j => j.parent === job.id)) return;
    // Every run of this archive, including one kept earlier for files taken from it.
    void deleteTempPrefix(this.session, `arc-${job.id}-`);
  }

  /** Unpacks an archive in the archive worker, then reads what each file is. */
  private async extract(job: Job): Promise<void> {
    if (job.tempPrefix && this.session && !this.jobs.some(j => j.parent === job.id)) await deleteTempPrefix(this.session, job.tempPrefix);
    const controller = new AbortController();
    Object.assign(job, { controller, status: 'converting', stage: 'Unpacking', fraction: 0, error: undefined, warnings: [], archive: undefined });
    job.startedAt = performance.now();
    this.onChange(job);
    const prefix = `arc-${job.id}-${Date.now()}`;
    const temp = this.session ? { session: this.session, prefix } : null;
    job.tempPrefix = temp ? prefix : undefined;
    try {
      const r = await this.engines.archive.run<ExtractResult>('extract', { file: job.file, kind: job.format, name: job.name, temp }, {
        signal: controller.signal,
        onProgress: p => { if (p.fraction !== undefined) job.fraction = p.fraction; this.onChange(job); },
      });
      job.stage = 'Checking the files';
      this.onChange(job);
      const entries: ArchiveEntry[] = [];
      for (const e of r.entries) {
        const s = await sniffBlob(e.file, e.name);
        const ok = s.format !== null && (FORMATS[s.format].category === 'archive' || targetsFor(s.format).length > 0) && !missingCapability(FORMATS[s.format].category);
        entries.push({ ...e, format: ok ? s.format : null, label: s.label });
      }
      job.archive = { entries, skipped: r.skipped };
      job.warnings = [...r.warnings];
      if (r.skipped.length) job.warnings.push(`${r.skipped.length} ${r.skipped.length === 1 ? 'entry was' : 'entries were'} not unpacked; ${r.skipped.length === 1 ? 'it is' : 'they are'} listed with the reason.`);
      const size = entries.reduce((n, e) => n + e.size, 0);
      job.summary = `${entries.length} ${entries.length === 1 ? 'file' : 'files'}, ${formatBytes(size)}`;
      job.status = 'done';
      job.fraction = 1;
    } catch (e) {
      if (this.session) void deleteTempPrefix(this.session, prefix);
      job.tempPrefix = undefined;
      if (e instanceof CanceledError || controller.signal.aborted) { job.status = 'canceled'; job.error = undefined; }
      else { job.status = 'failed'; job.error = isLoadFailure(e) ? loadFailureMessage() : (e as Error).message || 'The archive could not be unpacked.'; }
    }
    job.controller = undefined;
    job.stage = undefined;
    job.runs++;
    this.onChange(job);
  }

  /** Adds files unpacked from an archive to the list, without uploading or copying them. */
  addFromArchive(job: Job, indexes: number[]): Job[] {
    const entries = indexes.map(i => job.archive?.entries[i]).filter((e): e is ArchiveEntry => !!e && e.format !== null);
    const added = this.add(entries.map(e => new File([e.file], e.name, { type: FORMATS[e.format!].mime })));
    for (const a of added) a.parent = job.id;
    return added;
  }

  clear(): void {
    for (const j of [...this.jobs]) {
      this.cancel(j);
      this.dropOutputs(j);
    }
    const archives = this.jobs.filter(j => j.tempPrefix);
    this.jobs = [];
    for (const a of archives) this.dropArchive(a);
    this.names.clear();
    this.onListChange();
  }

  private dropOutputs(job: Job, keepName?: string): void {
    for (const o of job.outputs) {
      if (o.name !== keepName) this.names.release(o.name);
      if (o.temp && this.session) void deleteTempFile(this.session, o.temp);
    }
    job.outputs = [];
  }

  get busy(): boolean {
    return this.jobs.some(j => j.status === 'converting' || j.status === 'queued' || j.status === 'checking');
  }

  private family(job: Job): string {
    const e = engineFor(job.format!, job.target!, job.traits);
    return e === 'gif-to-video' || e === 'video-to-gif' ? 'media' : e;
  }

  private limit(family: string): number {
    return family === 'image' ? 2 : 1;
  }

  private pump(): void {
    for (const job of [...this.pending]) {
      const fam = this.family(job);
      const n = this.running.get(fam) ?? 0;
      if (n >= this.limit(fam)) continue;
      this.pending = this.pending.filter(j => j !== job);
      this.running.set(fam, n + 1);
      void this.run(job).finally(() => {
        this.running.set(fam, (this.running.get(fam) ?? 1) - 1);
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const from = job.format!, to = job.target!;
    const signal = job.controller!.signal;
    job.status = 'converting';
    job.startedAt = performance.now();
    job.warnings = [];
    job.stage = 'Starting';
    this.onChange(job);
    const onProgress = (p: { fraction?: number; stage?: string }) => {
      if (p.fraction !== undefined) job.fraction = p.fraction;
      if (p.stage !== undefined) job.stage = p.stage;
      this.onChange(job);
    };
    const base = safeBase(job.name);
    const s = this.getSettings();
    const tempStamp = Date.now();
    try {
      let outs: Array<{ blob: Blob; ext: string; suffix?: string; temp?: string }>;
      const engine = engineFor(from, to, job.traits);
      const tempName = `job-${job.id}-${tempStamp}.${FORMATS[to].ext}`;
      const temp = this.session ? { session: this.session, name: tempName } : null;
      if (engine === 'image') {
        // An SVG is drawn into pixels on the page first (browsers cannot draw SVG in a worker), as a lossless PNG.
        let file: Blob = job.file, source = from;
        const drawn: string[] = [];
        if (from === 'svg') {
          onProgress({ stage: 'Drawing the SVG' });
          const { rasterizeSvg } = await import('../engines/image/svg');
          const svg = await rasterizeSvg(job.file, s.image.svgSize as SvgSize);
          if (signal.aborted) throw new CanceledError();
          file = svg.png;
          source = 'png';
          drawn.push(...svg.warnings);
        }
        const r = await this.engines.image.run<ImageResult>('convert', { file, from: source, to, options: s.image }, { onProgress, signal });
        job.warnings = [...drawn, ...r.warnings];
        job.summary = r.summary;
        outs = r.outputs.map(o => ({ blob: new Blob([o.bytes as Uint8Array<ArrayBuffer>], { type: r.mime }), ext: r.ext, suffix: o.suffix }));
      } else if (engine === 'media' || engine === 'video-to-gif' || engine === 'gif-to-video') {
        const options = {
          // Sound this browser cannot decode is left out, as the note on the row said when the file was added.
          maxHeight: s.video.maxHeight, videoQuality: s.video.quality, removeAudio: s.video.removeAudio || job.traits.hasAudio === false,
          audioBitrate: s.audio.bitrate, sampleRate: s.audio.sampleRate, channels: s.audio.channels,
          gifWidth: s.video.gifWidth, gifFps: s.video.gifFps, background: s.image.background,
        };
        const task = engine === 'media' ? 'convert' : engine === 'video-to-gif' ? 'videoToGif' : 'gifToVideo';
        const r = await this.engines.media.run<MediaResult>(task, { file: job.file, from, to, options, temp: engine === 'video-to-gif' ? null : temp }, { onProgress, signal });
        job.warnings = r.warnings;
        job.summary = r.summary;
        const usedTemp = temp && r.file instanceof File ? tempName : undefined;
        outs = [{ blob: r.file, ext: r.ext, temp: usedTemp }];
      } else if (engine === 'document') {
        outs = await this.runDocument(job, from, to, s, onProgress, signal);
      } else {
        const options = { ...s.data, sheet: job.sheet === 'first' || job.sheet === 'all' ? job.sheet : { name: job.sheet } };
        const r = await this.engines.data.run<DataResult>('convert', { file: job.file, from, to, options, baseName: base }, { onProgress, signal });
        job.warnings = r.warnings;
        job.summary = r.summary;
        outs = r.outputs.map(o => ({ blob: new Blob([o.bytes as Uint8Array<ArrayBuffer>], { type: o.mime }), ext: o.ext, suffix: o.suffix }));
      }
      if (signal.aborted) throw new CanceledError();
      const reserved = job.reserved;
      job.reserved = undefined;
      this.dropOutputs(job, reserved);
      const single = outs.length === 1 && !outs[0].suffix && reserved?.toLowerCase().endsWith(`.${outs[0].ext}`);
      if (reserved && !single) this.names.release(reserved);
      job.outputs = outs.map(o => ({
        name: single ? reserved! : this.names.claim(o.suffix ? `${base} - ${safeBase(o.suffix + '.x')}` : base, o.ext),
        blob: o.blob,
        temp: o.temp,
      }));
      job.madeAs = to;
      job.status = 'done';
      job.fraction = 1;
      const secs = (performance.now() - (job.startedAt ?? 0)) / 1000;
      const size = job.outputs.reduce((n, o) => n + o.blob.size, 0);
      job.summary = [job.summary, formatBytes(size), secs >= 1 ? `${secs.toFixed(1)} s` : null].filter(Boolean).join(', ');
    } catch (e) {
      // A worker that was stopped or failed cannot remove its own partial file, so the page does.
      if (this.session) void deleteTempFile(this.session, `job-${job.id}-${tempStamp}.${FORMATS[to].ext}`);
      if (job.reserved && !job.outputs.some(o => o.name === job.reserved)) this.names.release(job.reserved);
      job.reserved = undefined;
      if (e instanceof CanceledError || signal.aborted) {
        job.status = 'canceled';
        job.error = undefined;
      } else {
        job.status = 'failed';
        job.error = isLoadFailure(e) ? loadFailureMessage() : (e as Error).message || 'The conversion failed.';
      }
    }
    job.controller = undefined;
    job.stage = undefined;
    job.runs++;
    this.onChange(job);
  }

  private async runDocument(job: Job, from: FormatId, to: FormatId, s: Settings, onProgress: (p: { fraction?: number; stage?: string }) => void, signal: AbortSignal) {
    const base = safeBase(job.name);
    const asBlob = (bytes: Uint8Array, ext: string) => [{ blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMATS[to].mime }), ext }];
    // Markdown with its pictures as separate files is a ZIP holding the .md and an assets folder.
    const markdownOut = (r: { bytes: Uint8Array; ext: 'md' | 'zip' }) => r.ext === 'zip'
      ? [{ blob: new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), ext: 'zip' }]
      : asBlob(r.bytes, 'md');
    if (from === 'txt' && to === 'pdf') {
      const r = await this.engines.document.run<{ bytes: Uint8Array; warnings: string[]; summary: string }>('textToPdf', { file: job.file, options: s.document, title: base }, { onProgress, signal });
      job.warnings = r.warnings; job.summary = r.summary;
      return asBlob(r.bytes, 'pdf');
    }
    if (from === 'docx' && (to === 'html' || to === 'md')) {
      const fragment = await this.engines.document.run<{ html: string; warnings: string[]; pictures: number }>('docxToHtml', { file: job.file }, { onProgress, signal });
      if (signal.aborted) throw new CanceledError();
      onProgress({ stage: to === 'md' ? 'Writing Markdown' : 'Writing the page' });
      const markup = await import('../engines/document/markup');
      if (to === 'md') {
        const r = await markup.docxHtmlToMarkdown(fragment.html, s.document.mdPictures, fragment.warnings, base);
        job.warnings = r.warnings; job.summary = r.summary;
        return markdownOut(r);
      }
      const r = markup.docxHtmlToPage(fragment.html, base, fragment.warnings);
      job.warnings = r.warnings; job.summary = r.summary;
      return asBlob(r.bytes, 'html');
    }
    if (from === 'docx' && to === 'txt') {
      const r = await this.engines.document.run<{ bytes: Uint8Array; warnings: string[]; summary: string }>('docxToText', { file: job.file }, { onProgress, signal });
      job.warnings = r.warnings; job.summary = r.summary;
      return asBlob(r.bytes, 'txt');
    }
    if (from === 'pdf' && to === 'txt') {
      const { pdfToText } = await import('../engines/document/pdf-text');
      const handle = pdfToText(job.file, (fraction, stage) => onProgress({ fraction, stage }));
      const abort = () => handle.cancel();
      signal.addEventListener('abort', abort);
      try {
        const r = await handle.promise;
        if (signal.aborted) throw new CanceledError();
        job.warnings = r.warnings; job.summary = r.summary;
        return asBlob(r.bytes, 'txt');
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
    const markup = await import('../engines/document/markup');
    const bytes = new Uint8Array(await job.file.arrayBuffer());
    if (from === 'md' && to === 'html') {
      const r = markup.markdownToHtml(bytes, base);
      job.warnings = r.warnings; job.summary = r.summary;
      return asBlob(r.bytes, 'html');
    }
    if (from === 'html' && to === 'md') {
      const r = await markup.htmlToMarkdown(bytes, s.document.mdPictures, base);
      job.warnings = r.warnings; job.summary = r.summary;
      return markdownOut(r);
    }
    if ((from === 'md' || from === 'html') && to === 'docx') {
      onProgress({ stage: 'Reading the document' });
      const req = from === 'md' ? markup.markdownToDocxRequest(bytes, base) : markup.htmlToDocxRequest(bytes, base);
      const r = await this.engines.document.run<{ bytes: Uint8Array; warnings: string[] }>('renderDocx', { html: req.html, title: req.title, pageSize: s.document.pageSize }, { onProgress, signal });
      job.warnings = [...req.warnings, ...r.warnings];
      job.summary = 'Word document';
      return asBlob(r.bytes, 'docx');
    }
    if ((from === 'md' || from === 'html') && to === 'pdf') {
      onProgress({ stage: 'Reading the document' });
      const req = markup.markupToPdfDoc(bytes, from, base, s.document.pageSize);
      const r = await this.engines.document.run<{ bytes: Uint8Array; missing: { count: number; examples: string[] } }>('renderPdf', { doc: req.doc, fonts: req.fonts as FontFile[], text: req.text }, { onProgress, signal });
      job.warnings = req.warnings;
      if (r.missing.count) job.warnings.push(`${r.missing.count} ${r.missing.count === 1 ? 'character is' : 'characters are'} not in the PDF font and will not show (for example ${r.missing.examples.join(' ')}). The font covers Latin, Greek and Cyrillic.`);
      job.summary = 'PDF document';
      return asBlob(r.bytes, 'pdf');
    }
    throw new Error(`No conversion from ${FORMATS[from].label} to ${FORMATS[to].label}.`);
  }

  /** All finished outputs, for the ZIP. */
  outputs(): JobOutput[] {
    return this.jobs.flatMap(j => j.status === 'done' ? j.outputs : []);
  }

  totalOutputBytes(): number {
    return this.outputs().reduce((n, o) => n + o.blob.size, 0);
  }

  zipAllowed(): { ok: boolean; reason?: string } {
    const total = this.totalOutputBytes();
    if (total > LIMITS.batchZipBytes) return { ok: false, reason: `The results add up to ${formatBytes(total)}, more than the ${formatBytes(LIMITS.batchZipBytes)} a ZIP can hold here. Download them one at a time.` };
    return { ok: this.outputs().length > 0 };
  }
}

const CODECS: Record<string, string> = { avc: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC-3', eac3: 'E-AC-3', alac: 'ALAC' };
function codec(c: string | null): string {
  if (!c) return 'unknown codec';
  return CODECS[c] ?? (c.startsWith('pcm') || c === 'ulaw' || c === 'alaw' ? 'PCM' : c.toUpperCase());
}
