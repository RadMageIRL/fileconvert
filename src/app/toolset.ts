// Loads a tool's code on demand, on the tool's own page. Each tool is its own chunk.

import type { ToolId } from '../core/tools';
import type { ToolDefinition } from './tools';

export async function loadTool(id: ToolId): Promise<ToolDefinition> {
  switch (id) {
    case 'remove-image-metadata': return (await import('../tools/metadata')).tool;
    case 'images-to-tiff': return (await import('../tools/combine-tiff')).tool;
    case 'images-to-pdf': return (await import('../tools/images-to-pdf')).tool;
    case 'merge-pdf': return (await import('../tools/merge-pdf')).tool;
    case 'split-pdf': return (await import('../tools/split-pdf')).tool;
    case 'extract-pdf-pages': return (await import('../tools/extract-pdf-pages')).tool;
    case 'delete-pdf-pages': return (await import('../tools/delete-pdf-pages')).tool;
    case 'organize-pdf': return (await import('../tools/organize-pdf')).tool;
    case 'rotate-pdf': return (await import('../tools/rotate-pdf')).tool;
  }
}
