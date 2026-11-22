// Output file names. A name from the user's file is never trusted as a path: it is reduced to a safe base
// name, given the new extension, and made unique within the session so two results can never overwrite
// each other in the download list or in a ZIP.

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_BASE = 120;

/** The base name of a file without its extension, safe on Windows, macOS and Linux and inside a ZIP. */
export function safeBase(name: string): string {
  let base = String(name).split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  base = base
    .normalize('NFC')
    // Control characters, the characters Windows forbids, and the Unicode direction overrides that can
    // disguise an extension.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (RESERVED.test(base)) base = '_' + base;
  if (base.length > MAX_BASE) base = base.slice(0, MAX_BASE).replace(/[\s.]+$/, '');
  return base || 'file';
}

/** Hands out unique output names, case-insensitively, the way most file systems compare them. */
export class NameRegistry {
  private taken = new Set<string>();

  /** Reserves and returns a unique name like "photo.png", "photo (2).png", or "README (2)" with no extension. */
  claim(base: string, ext: string): string {
    const clean = safeBase(base + '.x');
    const e = ext.replace(/[^a-z0-9]/gi, '').toLowerCase();
    for (let n = 1; ; n++) {
      const stem = n === 1 ? clean : `${clean} (${n})`;
      const name = e ? `${stem}.${e}` : stem;
      const key = name.toLowerCase();
      if (!this.taken.has(key)) {
        this.taken.add(key);
        return name;
      }
    }
  }

  release(name: string): void {
    this.taken.delete(name.toLowerCase());
  }

  clear(): void {
    this.taken.clear();
  }
}
