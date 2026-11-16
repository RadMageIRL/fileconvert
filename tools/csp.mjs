// The Content-Security-Policy FileConvert runs under. The build writes it into the page as a meta tag
// (adding the hash of the one inline script), tools/serve.mjs sends it as a header in the browser tests, and
// radmagelabs.com/fileconvert/ is meant to send it as a header with frame-ancestors added.
//
// Everything loads from the app's own origin. 'wasm-unsafe-eval' lets the WebAssembly codecs compile;
// blob: workers are the MP3, AAC and FLAC encoders, which start their own worker from bundled code.
// connect-src 'self' covers the app fetching its own WebAssembly, fonts and pdf.js character maps.
// Nothing may be fetched from, or sent to, any other site.
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' blob: data:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** The extra directive a real header can carry (meta tags ignore it). */
export const FRAME_ANCESTORS = "frame-ancestors 'none'";
