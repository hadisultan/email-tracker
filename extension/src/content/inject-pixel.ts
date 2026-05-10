// Pure HTML manipulation helper for the tracking pixel. Kept pure so it
// can be unit-tested without a real Gmail compose dialog. The actual
// injection into the editor happens in the orchestrator (gmail.ts),
// which prefers `document.execCommand('insertHTML', ...)` so Gmail's
// internal editor model recognizes the change as a user-initiated edit;
// `appendPixelToHtml` is the fallback path used when execCommand is
// unavailable (test environment, or browsers that have removed
// execCommand entirely).
//
// Gmail's compose body is a contenteditable <div>, not an iframe, so
// we hand back a plain HTML string and let the orchestrator assign it
// via innerHTML. The pixel is a 1x1 transparent gif served by
// `/api/pixel/<token>` (see functions/pixel.ts) and is hidden via
// inline style so it can't reflow the layout in clients that strip
// CSS classes.

const PIXEL_ATTRS =
  'width="1" height="1" alt="" style="display:none;border:0;"';

export function appendPixelToHtml(bodyHtml: string, pixelUrl: string): string {
  return bodyHtml + buildPixelImgHtml(pixelUrl);
}

// Returns just the `<img>` snippet (no surrounding body). The orchestrator
// uses this with execCommand('insertHTML') so the change is routed
// through Gmail's editor model rather than a programmatic innerHTML
// overwrite (which Gmail's send handler does not consistently observe
// before reading the body for outgoing serialization).
export function buildPixelImgHtml(pixelUrl: string): string {
  const safeUrl = escapeHtmlAttr(pixelUrl);
  return `<img src="${safeUrl}" ${PIXEL_ATTRS}>`;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
