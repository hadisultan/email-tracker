// Pure HTML manipulation helper for the tracking pixel. Kept pure so it
// can be unit-tested without a real Gmail compose dialog. The actual
// `bodyEditor.innerHTML = ...` write happens in the orchestrator
// (gmail.ts), which calls this and assigns the result.
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
  const safeUrl = escapeHtmlAttr(pixelUrl);
  const img = `<img src="${safeUrl}" ${PIXEL_ATTRS}>`;
  return bodyHtml + img;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
