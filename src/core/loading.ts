// Messages for when part of the app cannot be downloaded. Converters load on first use, so a tab that stays
// open across an update can ask for a file the new version no longer has, and an offline tab cannot fetch a
// converter it never loaded. Both deserve a clear next step rather than a raw browser error.

/** True when an error means a script or module could not be fetched (Chrome, Edge, Firefox and Safari wording). */
export function isLoadFailure(e: unknown): boolean {
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' && /dynamically imported module|Importing a module script failed|Unable to preload CSS|error loading dynamically imported module|Failed to load module script/i.test(m);
}

export const OFFLINE_MESSAGE = 'This converter has not been downloaded yet, and the device is offline. Reconnect and try again; once loaded, it keeps working offline while the tab stays open.';

export const UPDATED_MESSAGE = 'Part of FileConvert could not be downloaded. FileConvert may have been updated since this page was opened: reload the page and add the file again.';

/** The message for a load failure, depending on whether the browser is online. */
export function loadFailureMessage(): string {
  return typeof navigator !== 'undefined' && navigator.onLine === false ? OFFLINE_MESSAGE : UPDATED_MESSAGE;
}
