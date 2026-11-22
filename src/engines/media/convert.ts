// Audio and video conversion, run inside a worker. Mediabunny reads and writes the containers in
// JavaScript; the browser's WebCodecs encoders and decoders do the heavy work (often on the GPU), and
// WebAssembly builds of LAME, FFmpeg's AAC encoder and libFLAC cover MP3, AAC and FLAC where the browser
// has no encoder. Streams are copied without re-encoding whenever the target container can hold them as
// they are, which is lossless and fast. Inputs are read in pieces, never loaded whole.

import {
  ALL_FORMATS, AdtsOutputFormat, BlobSource, BufferTarget, CanvasSink, CanvasSource, Conversion, CustomSource,
  ConversionCanceledError, FlacOutputFormat, Input, MkvOutputFormat, MovOutputFormat, Mp3OutputFormat,
  Mp4OutputFormat, OggOutputFormat, Output, Quality, StreamTarget, WavOutputFormat, WebMOutputFormat,
  canEncodeAudio, canEncodeVideo,
  type AudioCodec, type InputAudioTrack, type InputVideoTrack, type MetadataTags, type OutputFormat, type QualityLevel, type Target, type VideoCodec,
} from 'mediabunny';
import { AUDIO_OUT, FORMATS, type FormatId } from '../../core/formats';
import { LIMITS, LimitError } from '../../core/limits';
import type { Progress } from '../../core/rpc';
import { createTempFile } from '../../core/tempstore';
import { GifWriter } from '../image/encoders';
import { openFrames } from '../image/frames';
import { readAiff, wavView } from './aiff';
import { tsStreams, unreadableStreams } from './tsinfo';

export interface MediaOptions {
  /** Largest output height in pixels, or 0 for the original size. Never upscales. */
  maxHeight: number;
  /** 'original' copies streams when the target can hold them, otherwise encodes at high quality. */
  videoQuality: 'original' | QualityLevel;
  removeAudio: boolean;
  /** Audio bitrate in kbit/s for lossy formats, or 0 for the encoder's high-quality default. */
  audioBitrate: number;
  /** 0 keeps the original. */
  sampleRate: number;
  channels: number;
  /** GIF output. */
  gifWidth: number;
  gifFps: number;
  /** Background for transparent GIF frames turned into video. */
  background: string;
}

export interface MediaInfo {
  container: string;
  duration: number | null;
  video: null | { codec: string | null; width: number; height: number; rotation: number; decodable: boolean; hdr: boolean };
  audio: null | { codec: string | null; channels: number; sampleRate: number; decodable: boolean };
  /** A transport stream's video that Mediabunny cannot read at all (MPEG-2, for example), by name. */
  unreadableVideo?: string | null;
  /** Other things about the file that the queue should say. */
  notes?: string[];
  /** Every track, for the "this file has 3 audio tracks" note. */
  videoTracks: number;
  audioTracks: number;
}

export interface MediaResult {
  file: Blob;
  ext: string;
  mime: string;
  warnings: string[];
  summary: string;
}

export interface TempTarget { session: string; name: string }

const CODEC_NAMES: Record<string, string> = {
  avc: 'H.264', hevc: 'HEVC (H.265)', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', prores: 'ProRes',
  aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD',
  alac: 'ALAC',
};
export const codecName = (c: string | null | undefined) => c ? (CODEC_NAMES[c] ?? (c.startsWith('pcm') ? 'PCM' : c.toUpperCase())) : 'an unknown codec';

let polyfills: Promise<void> | null = null;
/** Registers the WebAssembly encoders for codecs this browser cannot encode itself. */
function ensureEncoders(): Promise<void> {
  if (!polyfills) {
    polyfills = (async () => {
      const [{ registerMp3Encoder }, { registerFlacEncoder }, { registerAacEncoder }] = await Promise.all([
        import('@mediabunny/mp3-encoder'), import('@mediabunny/flac-encoder'), import('@mediabunny/aac-encoder'),
      ]);
      if (!(await canEncodeAudio('mp3'))) registerMp3Encoder();
      if (!(await canEncodeAudio('flac'))) registerFlacEncoder();
      if (!(await canEncodeAudio('aac'))) registerAacEncoder();
    })();
  }
  return polyfills;
}

/** Opens a media file; an AIFF file is read through its WAV view (./aiff). */
async function openInput(file: Blob, format?: FormatId): Promise<Input> {
  if (format === 'aiff') return new Input({ source: new CustomSource(wavView(file, await readAiff(file))), formats: ALL_FORMATS });
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

export async function inspectMedia(file: Blob, kind?: FormatId): Promise<MediaInfo> {
  const input = await openInput(file, kind);
  try {
    if (!(await input.canRead())) throw new Error('This file is not a media file FileConvert can read, or it is damaged.');
    const format = await input.getFormat();
    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    let duration: number | null = await input.getDurationFromMetadata().catch(() => null);
    if (duration === null || !Number.isFinite(duration)) duration = await input.computeDuration().catch(() => null);
    // Timestamps need not start at zero (a transport stream often starts after a second or so).
    if (duration !== null) duration = Math.max(0, duration - await input.getFirstTimestamp().catch(() => 0));
    let unreadableVideo: string | null = null;
    const notes: string[] = [];
    if (kind === 'ts') {
      const u = unreadableStreams(tsStreams(new Uint8Array(await file.slice(0, 2 * 1048576).arrayBuffer())), { video: videoTracks.length, audio: audioTracks.length });
      unreadableVideo = u.video;
      notes.push(...u.audio);
    }
    return {
      container: format.name,
      duration,
      unreadableVideo,
      notes,
      videoTracks: videoTracks.length,
      audioTracks: audioTracks.length,
      video: v ? {
        codec: await v.getCodec(),
        width: await v.getDisplayWidth(),
        height: await v.getDisplayHeight(),
        rotation: await v.getRotation(),
        decodable: await v.canDecode(),
        hdr: await v.hasHighDynamicRange().catch(() => false),
      } : null,
      audio: a ? {
        codec: await a.getCodec(),
        channels: await a.getNumberOfChannels(),
        sampleRate: await a.getSampleRate(),
        decodable: await a.canDecode(),
      } : null,
    };
  } finally {
    input.dispose();
  }
}

/**
 * MP4 and MOV put their index at the start ("fast start") so players can begin before the end has loaded.
 * In memory that is free; when streaming to disk, space is reserved for it ('reserve', sized by the
 * conversion), or, for frame-by-frame output with no known length, the index goes at the end.
 */
function outputFormat(to: FormatId, streaming: boolean, knownLength = true): OutputFormat {
  const fastStart = !streaming ? 'in-memory' as const : knownLength ? 'reserve' as const : false as const;
  switch (to) {
    case 'mp4': case 'm4a': return new Mp4OutputFormat({ fastStart });
    case 'mov': return new MovOutputFormat({ fastStart });
    case 'mkv': return new MkvOutputFormat();
    case 'webm': return new WebMOutputFormat();
    case 'mp3': return new Mp3OutputFormat();
    case 'wav': return new WavOutputFormat();
    case 'flac': return new FlacOutputFormat();
    case 'aac': return new AdtsOutputFormat();
    case 'ogg': return new OggOutputFormat();
  }
  throw new Error(`No media output for ${to}.`);
}

/** Preferred codecs per target, most compatible first. */
const VIDEO_CODECS: Partial<Record<FormatId, VideoCodec[]>> = {
  mp4: ['avc', 'hevc', 'vp9', 'av1'],
  mov: ['avc', 'hevc'],
  mkv: ['avc', 'hevc', 'vp9', 'av1'],
  webm: ['vp9', 'vp8', 'av1'],
};
const AUDIO_CODECS: Record<string, AudioCodec[]> = {
  mp4: ['aac'], mov: ['aac'], mkv: ['aac'], webm: ['opus', 'vorbis'], m4a: ['aac'], aac: ['aac'],
  mp3: ['mp3'], ogg: ['opus', 'vorbis'], flac: ['flac'], wav: ['pcm-s16'],
};

async function firstVideoCodec(to: FormatId, width: number, height: number): Promise<VideoCodec | null> {
  for (const c of VIDEO_CODECS[to] ?? []) if (await canEncodeVideo(c, { width, height })) return c;
  return null;
}
async function firstAudioCodec(to: FormatId, channels: number, sampleRate: number): Promise<AudioCodec | null> {
  for (const c of AUDIO_CODECS[to] ?? []) {
    if (c.startsWith('pcm')) return c;
    const rate = c === 'opus' ? 48000 : sampleRate;
    if (await canEncodeAudio(c, { numberOfChannels: Math.min(2, channels || 2), sampleRate: rate })) return c;
  }
  return null;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Sets up where the result is written: a temporary OPFS file when possible, memory otherwise. */
async function makeTarget(temp: TempTarget | null): Promise<{ target: Target; streaming: boolean; finish(): Promise<Blob>; abort(): Promise<void>; memoryNote?: string }> {
  if (temp) {
    try {
      const tf = await createTempFile(temp.session, temp.name);
      const target = new StreamTarget(tf.writable as unknown as WritableStream, { chunked: true, chunkSize: 8 * 1024 * 1024 });
      return { target, streaming: true, finish: () => tf.finish(), abort: () => tf.abort() };
    } catch { /* fall through to memory */ }
  }
  const target = new BufferTarget();
  return {
    target,
    streaming: false,
    finish: async () => new Blob([target.buffer as ArrayBuffer]),
    abort: async () => undefined,
    memoryNote: 'This browser has no private file storage available (private windows often do not), so the result is held in memory.',
  };
}

export async function convertMedia(file: Blob, from: FormatId, to: FormatId, o: MediaOptions, progress: Progress, temp: TempTarget | null): Promise<MediaResult> {
  if (file.size > LIMITS.mediaBytes) throw new LimitError(`The file is larger than ${LIMITS.mediaBytes / 1073741824} GB, the limit for audio and video.`);
  if (!temp && file.size > LIMITS.mediaInMemoryBytes) {
    throw new LimitError(`This browser cannot store large results privately, and the file is larger than ${Math.round(LIMITS.mediaInMemoryBytes / 1048576)} MB, the limit in memory.`);
  }
  await ensureEncoders();
  const warnings: string[] = [];
  const audioOnly = AUDIO_OUT.includes(to);
  const input = await openInput(file, from);
  const out = await makeTarget(temp);
  try {
    if (!(await input.canRead())) throw new Error(`This ${FORMATS[from].label} file could not be read. It may be damaged or use a layout FileConvert does not support.`);
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const extraAudio = (await input.getAudioTracks()).length - (a ? 1 : 0);
    const extraVideo = (await input.getVideoTracks()).length - (v ? 1 : 0);
    if (audioOnly && !a) throw new Error('This file has no audio track to convert.');
    if (!audioOnly && !v) throw new Error(`This file has no video track. Choose an audio format instead.`);
    if (a && !(await a.canDecode()) && !(o.removeAudio && !audioOnly)) {
      throw new Error(`The audio is ${codecName(await a.getCodec())}, which this browser cannot decode.`);
    }
    if (!audioOnly && v && !(await v.canDecode())) {
      const name = codecName(await v.getCodec());
      throw new Error(`The video is ${name}, which this browser cannot decode.${name.startsWith('HEVC') ? ' HEVC decoding depends on your browser and hardware; Chrome and Edge on recent Windows and macOS usually have it, Firefox does not.' : ''}`);
    }

    let videoOpts: Record<string, unknown> | undefined;
    let chosenVideo: string | null = null;
    if (!audioOnly && v) {
      const srcW = await v.getDisplayWidth(), srcH = await v.getDisplayHeight();
      let w = srcW, h = srcH;
      const resizing = o.maxHeight > 0 && srcH > o.maxHeight;
      if (resizing) { h = even(o.maxHeight); w = even(srcW * (h / srcH)); }
      const codec = await firstVideoCodec(to, w, h);
      if (!codec) throw new Error(`This browser cannot encode video for ${FORMATS[to].label} at ${w} x ${h}.`);
      chosenVideo = codec;
      const preferred = VIDEO_CODECS[to]![0];
      if (codec !== preferred) warnings.push(`This browser cannot encode ${codecName(preferred)} at this size, so the video is ${codecName(codec)}, which some players cannot open.`);
      videoOpts = { codec };
      if (resizing) { videoOpts.width = w; videoOpts.height = h; videoOpts.fit = 'fill'; }
      if (o.videoQuality !== 'original') videoOpts.quality = new Quality(o.videoQuality);
      if (await v.hasHighDynamicRange().catch(() => false)) warnings.push('The video is HDR. If it is re-encoded, colors are not tone-mapped and can look washed out.');
    }

    let audioOpts: Record<string, unknown> | undefined;
    let chosenAudio: string | null = null;
    if (a && !(o.removeAudio && !audioOnly)) {
      const channels = o.channels || await a.getNumberOfChannels();
      const rate = o.sampleRate || await a.getSampleRate();
      const codec = await firstAudioCodec(to, channels, rate);
      if (!codec) throw new Error(`This browser cannot encode audio for ${FORMATS[to].label}.`);
      chosenAudio = codec;
      audioOpts = { codec };
      if (o.channels) audioOpts.numberOfChannels = o.channels;
      else if (codec !== 'flac' && !codec.startsWith('pcm') && channels > 2) {
        audioOpts.numberOfChannels = 2;
        warnings.push(`The ${channels}-channel audio was mixed down to stereo.`);
      }
      if (codec === 'opus') { if (rate !== 48000) audioOpts.sampleRate = 48000; }
      else if (o.sampleRate) audioOpts.sampleRate = o.sampleRate;
      const lossy = codec === 'mp3' || codec === 'aac' || codec === 'opus' || codec === 'vorbis';
      if (lossy && o.audioBitrate > 0) audioOpts.quality = new Quality({ bitrate: o.audioBitrate * 1000 });
    }

    const conversion = await Conversion.init({
      input,
      output: new Output({ format: outputFormat(to, out.streaming), target: out.target }),
      video: audioOnly || !v ? { discard: true } : async (track: InputVideoTrack) => track === v || track.number === v.number ? videoOpts! : { discard: true },
      audio: !audioOpts ? { discard: true } : async (track: InputAudioTrack) => track === a || track.number === a?.number ? audioOpts! : { discard: true },
      // AAC from MP4 usually starts slightly before zero (encoder priming). Some containers cannot hold that, so a
      // shift of up to half a second is allowed to copy the stream instead of re-encoding it; the tracks stay in sync.
      copy: { mode: 'preferred', shiftTolerance: 0.5 },
      // Descriptive tags (title, artist, album, cover art) are kept. Raw container metadata, which can hold
      // things like a phone's recording location, is not.
      tags: (t: MetadataTags) => ({
        title: t.title, description: t.description, artist: t.artist, album: t.album, albumArtist: t.albumArtist,
        trackNumber: t.trackNumber, tracksTotal: t.tracksTotal, discNumber: t.discNumber, discsTotal: t.discsTotal,
        beatsPerMinute: t.beatsPerMinute, genre: t.genre, date: t.date, lyrics: t.lyrics, comment: t.comment, images: t.images,
      }),
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map(d => `${d.track.type} track: ${d.reason.replace(/_/g, ' ')}`).join('; ');
      throw new Error(`This conversion is not possible in this browser (${why}).`);
    }
    if (extraAudio > 0 && !(o.removeAudio && !audioOnly)) warnings.push(`The file has ${extraAudio + 1} audio tracks; the first was kept.`);
    if (extraVideo > 0 && !audioOnly) warnings.push(`The file has ${extraVideo + 1} video tracks; the first was kept.`);
    let last = -1;
    conversion.onProgress = f => {
      const pct = Math.floor(f * 1000);
      if (pct !== last) { last = pct; progress({ fraction: f }); }
    };
    progress({ fraction: 0, stage: 'Converting' });
    await conversion.execute();
    progress({ stage: 'Finishing' });
    const blob = await out.finish();
    if (out.memoryNote && blob.size > 512 * 1048576) warnings.push(out.memoryNote);
    const parts: string[] = [];
    if (chosenVideo) parts.push(codecName(chosenVideo));
    if (chosenAudio) parts.push(codecName(chosenAudio));
    return { file: blob, ext: FORMATS[to].ext, mime: FORMATS[to].mime, warnings, summary: parts.join(', ') };
  } catch (e) {
    await out.abort();
    if (e instanceof ConversionCanceledError) throw new Error('Canceled.');
    throw e;
  } finally {
    input.dispose();
  }
}

// ------------------------------------------------------------------ video to GIF

export async function videoToGif(file: Blob, o: MediaOptions, progress: Progress): Promise<MediaResult> {
  const warnings: string[] = [];
  const input = await openInput(file);
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw new Error('This file has no video track.');
    if (!(await v.canDecode())) throw new Error(`The video is ${codecName(await v.getCodec())}, which this browser cannot decode.`);
    const srcW = await v.getDisplayWidth(), srcH = await v.getDisplayHeight();
    const width = Math.min(srcW, o.gifWidth || 480, LIMITS.gifMaxWidth);
    const height = Math.max(1, Math.round(srcH * (width / srcW)));
    const start = await v.getFirstTimestamp();
    const end = await v.computeDuration();
    const fps = Math.max(1, Math.min(30, o.gifFps || 10));
    let count = Math.max(1, Math.floor((end - start) * fps));
    if (count > LIMITS.gifFrames) {
      warnings.push(`GIFs are limited to ${LIMITS.gifFrames} frames, so only the first ${Math.round(LIMITS.gifFrames / fps)} seconds were converted.`);
      count = LIMITS.gifFrames;
    }
    const sink = new CanvasSink(v, { width, height, fit: 'fill', poolSize: 2 });
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
    const writer = new GifWriter(width, height, 0);
    const times = Array.from({ length: count }, (_, i) => start + i / fps);
    const delay = Math.round(1000 / fps);
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (wc) {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(wc.canvas, 0, 0);
        writer.add(ctx.getImageData(0, 0, width, height).data, delay);
      }
      i++;
      progress({ fraction: i / count, stage: `Frame ${i} of ${count}` });
    }
    const bytes = writer.finish();
    if (await input.getPrimaryAudioTrack()) warnings.push('GIF has no sound; the audio was left out.');
    warnings.push('GIF holds at most 256 colors per frame, so colors were reduced.');
    return { file: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/gif' }), ext: 'gif', mime: 'image/gif', warnings, summary: `${width} x ${height}, ${count} frames at ${fps} fps` };
  } finally {
    input.dispose();
  }
}

// ------------------------------------------------------------------ animation (GIF, WebP, APNG) to video

export async function gifToVideo(file: Blob, from: FormatId, to: FormatId, o: MediaOptions, progress: Progress, temp: TempTarget | null): Promise<MediaResult> {
  const warnings: string[] = [];
  const kind = from === 'webp' || from === 'png' ? from : 'gif';
  const src = await openFrames(new Uint8Array(await file.arrayBuffer()), kind);
  const W = src.width, H = src.height;
  if (W * H > LIMITS.imagePixels) { src.close(); throw new LimitError('The animation is too large to convert.'); }
  if (src.frames < 2) { src.close(); throw new Error('This picture is not animated. Convert it to an image format instead.'); }
  let outW = W, outH = H;
  if (o.maxHeight > 0 && H > o.maxHeight) { outH = o.maxHeight; outW = Math.round(W * (outH / H)); }
  // 4:2:0 video needs even dimensions; the frame is padded with the background color.
  outW = even(outW); outH = even(outH);
  const codec = await firstVideoCodec(to, outW, outH);
  if (!codec) { src.close(); throw new Error(`This browser cannot encode video for ${FORMATS[to].label}.`); }
  const preferred = VIDEO_CODECS[to]![0];
  if (codec !== preferred) warnings.push(`This browser cannot encode ${codecName(preferred)} at this size, so the video is ${codecName(codec)}, which some players cannot open.`);
  const out = await makeTarget(temp);
  try {
    const output = new Output({ format: outputFormat(to, out.streaming, false), target: out.target });
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d')!;
    const source = new CanvasSource(canvas, { codec, bitrate: new Quality(o.videoQuality === 'original' ? 'high' : o.videoQuality) });
    output.addVideoTrack(source);
    await output.start();
    let t = 0, n = 0;
    let transparent = false;
    for (let f = await src.next(); f; f = await src.next()) {
      const fctx = f.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      if (!transparent) { const d = fctx.getImageData(0, 0, W, H).data; for (let k = 3; k < d.length; k += 64) if (d[k] < 255) { transparent = true; break; } }
      ctx.fillStyle = o.background;
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(f.canvas, 0, 0, Math.round(W * (outH / H)), outH);
      const delay = f.duration / 1000;
      await source.add(t, delay);
      t += delay;
      n++;
      progress({ fraction: n / src.frames, stage: `Frame ${n} of ${src.frames}` });
    }
    source.close();
    await output.finalize();
    const blob = await out.finish();
    if (transparent) warnings.push('Video has no transparency, so transparent areas became the background color.');
    warnings.push('Videos do not loop on their own the way animated pictures do.');
    return { file: blob, ext: FORMATS[to].ext, mime: FORMATS[to].mime, warnings, summary: `${outW} x ${outH}, ${codecName(codec)}, ${t.toFixed(1)} s` };
  } catch (e) {
    await out.abort();
    throw e;
  } finally {
    src.close();
  }
}
