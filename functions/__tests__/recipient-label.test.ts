import { describe, expect, it } from 'vitest';
import { recipientLabel } from '../lib/notify.js';

// Regression: production push body said "21 recipients" for a single-
// recipient message because postgres-js's type catalog was disabled and
// text[] came back as the raw wire form `'{owner@example.com}'`
// (length 21). recipientLabel now re-parses defensively.
describe('recipientLabel', () => {
  it('returns the address verbatim for a single-element array', () => {
    expect(recipientLabel(['a@x.com'])).toBe('a@x.com');
  });

  it('returns "<n> recipients" for multiple addresses', () => {
    expect(recipientLabel(['a@x.com', 'b@x.com', 'c@x.com'])).toBe('3 recipients');
  });

  it('returns "(no recipients)" for null or empty', () => {
    expect(recipientLabel(null)).toBe('(no recipients)');
    expect(recipientLabel([])).toBe('(no recipients)');
    expect(recipientLabel('')).toBe('(no recipients)');
  });

  it('parses Postgres array literal string with one entry', () => {
    expect(recipientLabel('{owner@example.com}')).toBe('owner@example.com');
  });

  it('parses Postgres array literal string with multiple entries', () => {
    expect(recipientLabel('{a@x.com,b@x.com,c@x.com}')).toBe('3 recipients');
  });

  it('parses an empty Postgres array literal as no recipients', () => {
    expect(recipientLabel('{}')).toBe('(no recipients)');
  });

  it('strips wrapping double-quotes from quoted entries', () => {
    expect(recipientLabel('{"a@x.com"}')).toBe('a@x.com');
    expect(recipientLabel('{"a@x.com","b@x.com"}')).toBe('2 recipients');
  });

  it('treats a non-array, non-literal string as a single recipient', () => {
    expect(recipientLabel('a@x.com')).toBe('a@x.com');
  });
});
