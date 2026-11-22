import type { FormatId } from '../core/formats';
import { serve } from '../core/rpc';
import { convertMedia, gifToVideo, inspectMedia, videoToGif, type MediaOptions, type TempTarget } from '../engines/media/convert';

interface Payload { file: Blob; from: FormatId; to: FormatId; options: MediaOptions; temp: TempTarget | null }

serve({
  async inspect(p: { file: Blob; format?: FormatId }) {
    return { result: await inspectMedia(p.file, p.format) };
  },
  async convert(p: Payload, progress) {
    return { result: await convertMedia(p.file, p.from, p.to, p.options, progress, p.temp) };
  },
  async videoToGif(p: Payload, progress) {
    return { result: await videoToGif(p.file, p.options, progress) };
  },
  async gifToVideo(p: Payload, progress) {
    return { result: await gifToVideo(p.file, p.from, p.to, p.options, progress, p.temp) };
  },
});
