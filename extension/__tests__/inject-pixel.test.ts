import { describe, expect, it } from 'vitest';
import { appendPixelToHtml } from '../src/content/inject-pixel.js';

const URL = 'http://localhost:8888/pixel/abc123';
const PIXEL_RE =
  /<img src="http:\/\/localhost:8888\/pixel\/abc123" width="1" height="1" alt="" style="display:none;border:0;">/;

describe('appendPixelToHtml', () => {
  it('appends the pixel to a non-empty body', () => {
    const html = '<div>Hello</div>';
    const out = appendPixelToHtml(html, URL);
    expect(out.startsWith(html)).toBe(true);
    expect(out).toMatch(PIXEL_RE);
    expect(out).toBe(html + out.slice(html.length));
  });

  it('handles an empty body without crashing', () => {
    const out = appendPixelToHtml('', URL);
    expect(out).toMatch(PIXEL_RE);
    expect(out.startsWith('<img')).toBe(true);
  });

  it('preserves an existing <img> in the body', () => {
    const html = '<p>see attached <img src="http://example.com/foo.png"></p>';
    const out = appendPixelToHtml(html, URL);
    expect(out.startsWith(html)).toBe(true);
    expect(out).toContain('http://example.com/foo.png');
    expect(out).toMatch(PIXEL_RE);
    const imgCount = (out.match(/<img\b/g) ?? []).length;
    expect(imgCount).toBe(2);
  });

  it('keeps trailing whitespace / signature blocks intact', () => {
    const html = '<p>body</p>\n<div class="signature">-- \nme</div>';
    const out = appendPixelToHtml(html, URL);
    expect(out.startsWith(html)).toBe(true);
  });

  it('escapes HTML-special characters in the pixel URL', () => {
    const tricky = 'http://localhost:8888/pixel/"><script>alert(1)</script>';
    const out = appendPixelToHtml('<p>x</p>', tricky);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&quot;');
    expect(out).toContain('&lt;script&gt;');
  });

  it('verifies the pixel is actually rendered as an img by the browser', () => {
    const out = appendPixelToHtml('<p>x</p>', URL);
    const div = document.createElement('div');
    div.innerHTML = out;
    const imgs = div.querySelectorAll('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.getAttribute('src')).toBe(URL);
    expect(imgs[0]!.getAttribute('width')).toBe('1');
    expect(imgs[0]!.getAttribute('height')).toBe('1');
    expect(imgs[0]!.getAttribute('style')).toContain('display:none');
  });
});
