import { describe, expect, it } from 'vitest';
import { detectSelfThreadView } from '../src/content/thread-detect.js';

describe('detectSelfThreadView', () => {
  it('detects #sent/<thread-id>', () => {
    expect(detectSelfThreadView({ hash: '#sent/THREAD123' })).toEqual({
      threadId: 'THREAD123',
    });
  });

  it('detects #label/Sent/<thread-id> (account-skin variant)', () => {
    expect(detectSelfThreadView({ hash: '#label/Sent/abc-def' })).toEqual({
      threadId: 'abc-def',
    });
  });

  it('is case-insensitive on the label segment', () => {
    expect(detectSelfThreadView({ hash: '#SENT/zzz' })).toEqual({
      threadId: 'zzz',
    });
    expect(detectSelfThreadView({ hash: '#label/SENT/zzz' })).toEqual({
      threadId: 'zzz',
    });
  });

  it('returns null for #inbox/<thread-id> (incoming-reply false-positive guard)', () => {
    expect(detectSelfThreadView({ hash: '#inbox/THREAD123' })).toBeNull();
  });

  it('returns null for arbitrary user labels', () => {
    expect(detectSelfThreadView({ hash: '#label/Foo/abc' })).toBeNull();
    expect(detectSelfThreadView({ hash: '#label/Important/xyz' })).toBeNull();
  });

  it('returns null for the bare #sent label (no thread open)', () => {
    expect(detectSelfThreadView({ hash: '#sent' })).toBeNull();
    expect(detectSelfThreadView({ hash: '#label/Sent' })).toBeNull();
  });

  it('returns null for an empty hash', () => {
    expect(detectSelfThreadView({ hash: '' })).toBeNull();
    expect(detectSelfThreadView({ hash: '#' })).toBeNull();
  });

  it('returns null for malformed thread IDs (trailing slash)', () => {
    expect(detectSelfThreadView({ hash: '#sent/' })).toBeNull();
    expect(detectSelfThreadView({ hash: '#sent//' })).toBeNull();
  });

  it('rejects extra path segments after the thread id', () => {
    // `#sent/<id>/draft/<x>` (compose-as-draft view) is not a thread
    // view in the sense we care about — drop it.
    expect(detectSelfThreadView({ hash: '#sent/abc/draft/xyz' })).toBeNull();
  });

  it('returns null for #drafts/<thread-id>', () => {
    expect(detectSelfThreadView({ hash: '#drafts/THREAD123' })).toBeNull();
  });

  it('returns null for #trash/<thread-id> (sent items the user trashed)', () => {
    // We treat trash as out of scope — the user isn't looking at a
    // tracked thread, they're managing trash. Cheap to skip beacons
    // here.
    expect(detectSelfThreadView({ hash: '#trash/THREAD123' })).toBeNull();
  });
});
