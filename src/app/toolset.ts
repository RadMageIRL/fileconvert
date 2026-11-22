// Loads a tool's code on demand, on the tool's own page. Each tool is its own chunk.

import type { ToolId } from '../core/tools';
import type { ToolDefinition } from './tools';

export async function loadTool(id: ToolId): Promise<ToolDefinition> {
  switch (id) {
    case 'remove-image-metadata': return (await import('../tools/metadata')).tool;
    case 'images-to-tiff': return (await import('../tools/combine-tiff')).tool;
    case 'merge-pdf': return (await import('../tools/merge-pdf')).tool;
  }
}
