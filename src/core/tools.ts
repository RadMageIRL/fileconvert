// The tools that have their own page. The tool code itself loads only on its page (src/app/toolset.ts); this list
// is what the page generator checks against, so a page can never name a tool that does not exist.

import type { FormatId } from './formats.ts';

/** What a tool needs from the browser beyond what every page needs: 'worker-canvas' is drawing in a worker, on an
 *  OffscreenCanvas (PDF to JPG and PNG). A browser without OffscreenCanvas on the page has none in workers either. */
export type Need = 'worker-canvas';

export const TOOLS = {
  'remove-image-metadata': { accepts: ['jpg', 'png', 'webp'] },
  'images-to-tiff': { accepts: ['jpg', 'png', 'webp', 'avif', 'heic', 'bmp', 'gif', 'tiff', 'ico'] },
  'images-to-pdf': { accepts: ['jpg', 'png', 'webp', 'avif', 'heic', 'bmp', 'gif', 'tiff'] },
  'merge-pdf': { accepts: ['pdf'] },
  'split-pdf': { accepts: ['pdf'] },
  'extract-pdf-pages': { accepts: ['pdf'] },
  'delete-pdf-pages': { accepts: ['pdf'] },
  'organize-pdf': { accepts: ['pdf'] },
  'rotate-pdf': { accepts: ['pdf'] },
  'pdf-to-images': { accepts: ['pdf'], needs: 'worker-canvas' },
  'remove-pdf-metadata': { accepts: ['pdf'] },
} as const satisfies Record<string, { accepts: readonly FormatId[]; needs?: Need }>;

export type ToolId = keyof typeof TOOLS;

export const isToolId = (id: string): id is ToolId => Object.hasOwn(TOOLS, id);

/** Why this browser cannot run the tool at all, or null. The tool's page and the catalog say so before anything is added. */
export function toolUnavailable(id: ToolId): string | null {
  const needs = (TOOLS[id] as { needs?: Need }).needs;
  if (needs === 'worker-canvas' && typeof OffscreenCanvas !== 'function') {
    return 'This browser cannot draw in the background (it has no OffscreenCanvas), so this tool cannot run here. Current Chrome, Edge, Firefox and Safari 16.4 or later can.';
  }
  return null;
}
