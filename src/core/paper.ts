// The paper a page-size choice starts with: US Letter where it is the usual paper, A4 everywhere else, and A4 when the
// region cannot be told. Only the browser's language settings are read (navigator.languages, navigator.language): no
// location, no address lookup, nothing sent anywhere. A choice the person makes is remembered by the tool that offers it
// (src/app/workspace.ts, an option's `remember`) and comes before this default.

/** Regions where Letter is the usual paper, from the Unicode CLDR paper size data (measurementData, US-Letter). */
export const LETTER_REGIONS: ReadonlySet<string> = new Set(['BZ', 'CA', 'CL', 'CO', 'CR', 'GT', 'MX', 'NI', 'PA', 'PH', 'PR', 'SV', 'US', 'VE']);

/** The region of a language tag ("en-US" is US, "zh-Hant-TW" is TW), or null when it names none ("en", "es-419"). */
export function regionOf(tag: string): string | null {
  const m = /^[a-z]{2,3}(?:-[a-z]{4})?-([a-z]{2})(?:-|$)/i.exec(tag.trim().replace(/_/g, '-'));
  return m ? m[1].toUpperCase() : null;
}

/** Letter or A4, from the first of the browser's languages that names a region; A4 when none does. */
export function defaultPaper(tags?: readonly string[]): 'letter' | 'a4' {
  const nav = globalThis.navigator as Navigator | undefined;
  const list = tags ?? (nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []);
  for (const t of list) {
    const r = regionOf(t);
    if (r) return LETTER_REGIONS.has(r) ? 'letter' : 'a4';
  }
  return 'a4';
}
