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

  it('detects #inbox/<thread-id> (self-sends and inbound-reply views)', () => {
    // Self-sends land in the inbox so Gmail surfaces them as `#inbox/<id>`
    // — without matching that, single-user testing never fires a beacon.
    // The false-positive class (sender views inbound reply on an
    // outbound thread before the recipient opens) is bounded by the
    // classifier's 5-min beacon window and is acceptable for the
    // single-user personal-tracker use case.
    expect(detectSelfThreadView({ hash: '#inbox/THREAD123' })).toEqual({
      threadId: 'THREAD123',
    });
    expect(detectSelfThreadView({ hash: '#INBOX/zzz' })).toEqual({
      threadId: 'zzz',
    });
  });

  it('detects long modern Gmail thread IDs (Qgrc... form)', () => {
    expect(
      detectSelfThreadView({
        hash: '#inbox/QgrcJHrjBQfqwnMJbWkcbwkQWjRzWJtTDTQ',
      }),
    ).toEqual({ threadId: 'QgrcJHrjBQfqwnMJbWkcbwkQWjRzWJtTDTQ' });
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
