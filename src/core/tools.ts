// The tools that have their own page. The tool code itself loads only on its page (src/app/toolset.ts); this list
// is what the page generator checks against, so a page can never name a tool that does not exist.

import type { FormatId } from './formats.ts';

export const TOOLS = {
  'remove-image-metadata': { accepts: ['jpg', 'png', 'webp'] },
  'images-to-tiff': { accepts: ['jpg', 'png', 'webp', 'avif', 'heic', 'bmp', 'gif', 'tiff', 'ico'] },
} as const satisfies Record<string, { accepts: readonly FormatId[] }>;

export type ToolId = keyof typeof TOOLS;

export const isToolId = (id: string): id is ToolId => Object.hasOwn(TOOLS, id);
