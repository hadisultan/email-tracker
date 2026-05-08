import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageRow, type MessageSummary } from '../src/components/MessageRow.js';
import type { PixelHit } from '../src/components/OpensTimeline.js';

afterEach(() => {
  cleanup();
});

const baseMessage: MessageSummary = {
  id: 'm1',
  subject: 'Hello there',
  recipients: ['alice@example.com'],
  sent_at: '2025-01-15T10:00:00Z',
  created_at: '2025-01-15T10:00:00Z',
  hit_count: 2,
};

describe('MessageRow', () => {
  it('renders subject, recipient, and hit count', () => {
    render(
      <MessageRow message={baseMessage} filter="real" loadHits={async () => []} />,
    );
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    // The hit count is rendered as <strong>2</strong> opens; assert on
    // the bold count and the trailing word independently.
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/opens/i)).toBeInTheDocument();
  });

  it('falls back to (no subject) when subject is null', () => {
    render(
      <MessageRow
        message={{ ...baseMessage, subject: null }}
        filter="real"
        loadHits={async () => []}
      />,
    );
    expect(screen.getByText('(no subject)')).toBeInTheDocument();
  });

  it('falls back to created_at when sent_at is null (e.g. orphan message that never made it through Gmail send)', () => {
    render(
      <MessageRow
        message={{
          ...baseMessage,
          sent_at: null,
          created_at: '2025-01-15T10:00:00Z',
        }}
        filter="real"
        loadHits={async () => []}
      />,
    );
    // We render a localised string of created_at when sent_at is null.
    // Use a year regex to avoid timezone flakiness.
    expect(screen.getByText(/Sent .*2025/)).toBeInTheDocument();
  });

  it('shows MultiRecipientNotice when there are multiple recipients', () => {
    render(
      <MessageRow
        message={{ ...baseMessage, recipients: ['a@x.com', 'b@x.com', 'c@x.com'] }}
        filter="real"
        loadHits={async () => []}
      />,
    );
    expect(screen.getByText(/3 recipients/i)).toBeInTheDocument();
  });

  it('shows AppleMPPNotice for icloud.com recipients', () => {
    render(
      <MessageRow
        message={{ ...baseMessage, recipients: ['friend@icloud.com'] }}
        filter="real"
        loadHits={async () => []}
      />,
    );
    expect(screen.getByText(/Apple Mail Privacy Protection/i)).toBeInTheDocument();
  });

  it('shows GmailCachingNotice when recipient is gmail and hit_count <= 1', () => {
    render(
      <MessageRow
        message={{ ...baseMessage, recipients: ['x@gmail.com'], hit_count: 1 }}
        filter="real"
        loadHits={async () => []}
      />,
    );
    expect(screen.getByText(/Gmail caches the tracking pixel/i)).toBeInTheDocument();
  });

  it('does not render the timeline until the user expands the row', async () => {
    const loader = vi.fn().mockResolvedValue([] as PixelHit[]);
    render(<MessageRow message={baseMessage} filter="real" loadHits={loader} />);
    expect(loader).not.toHaveBeenCalled();
    expect(screen.queryByText(/no opens yet/i)).not.toBeInTheDocument();
  });

  it('lazy-loads pixel hits on first expand and renders OpensTimeline', async () => {
    const hit: PixelHit = {
      id: 'hit1',
      hit_at: '2025-01-15T11:00:00Z',
      ip: '1.2.3.4',
      user_agent: 'Test',
      geo: { city: 'Boston', country: 'US' },
      proxy_label: null,
      tag: 'none',
    };
    const loader = vi.fn().mockResolvedValue([hit]);
    render(<MessageRow message={baseMessage} filter="real" loadHits={loader} />);
    const button = screen.getByRole('button', { expanded: false });
    await userEvent.click(button);

    // Loader should have been called exactly once with the message id.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith('m1', 'real');

    // Timeline appears.
    expect(await screen.findByText('Boston, US')).toBeInTheDocument();
    expect(screen.getByLabelText(/tag: real open/i)).toBeInTheDocument();

    // Collapsing then re-expanding does NOT re-fetch.
    await userEvent.click(screen.getByRole('button', { expanded: true }));
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('renders the empty-state copy when there are zero hits to show', async () => {
    const loader = vi.fn().mockResolvedValue([] as PixelHit[]);
    render(<MessageRow message={baseMessage} filter="real" loadHits={loader} />);
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText(/no opens yet/i)).toBeInTheDocument();
  });

  it('shows the loader error message when loadHits rejects', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('rls denied'));
    render(<MessageRow message={baseMessage} filter="real" loadHits={loader} />);
    await userEvent.click(screen.getByRole('button'));
    const row = screen.getByTestId('message-row');
    expect(await within(row).findByText(/Failed to load opens: rls denied/i)).toBeInTheDocument();
  });

  it('refetches with the new filter when the filter changes while expanded', async () => {
    const realHit: PixelHit = {
      id: 'h-real',
      hit_at: '2025-01-15T11:00:00Z',
      ip: null,
      user_agent: null,
      geo: { city: 'Boston', country: 'US' },
      proxy_label: null,
      tag: 'none',
    };
    const allHit: PixelHit = {
      id: 'h-self',
      hit_at: '2025-01-15T10:30:00Z',
      ip: null,
      user_agent: null,
      geo: { city: 'NYC', country: 'US' },
      proxy_label: null,
      tag: 'self_view_desktop',
    };
    const loader = vi
      .fn()
      .mockImplementation(async (_id: string, f: 'real' | 'all' | 'hidden') =>
        f === 'real' ? [realHit] : [realHit, allHit],
      );
    const { rerender } = render(
      <MessageRow message={baseMessage} filter="real" loadHits={loader} />,
    );
    // Expand, see the 'real'-filtered hit.
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    expect(await screen.findByText('Boston, US')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenLastCalledWith('m1', 'real');

    // Switch parent filter to 'all' while expanded — should refetch.
    rerender(<MessageRow message={baseMessage} filter="all" loadHits={loader} />);
    expect(await screen.findByText('NYC, US')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith('m1', 'all');
  });

  it('drops cached hits when the filter changes while collapsed and re-fetches on next expand', async () => {
    const loader = vi.fn().mockResolvedValue([] as PixelHit[]);
    const { rerender } = render(
      <MessageRow message={baseMessage} filter="real" loadHits={loader} />,
    );
    // Expand once → loader called with 'real'.
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByText(/no opens yet/i);
    expect(loader).toHaveBeenCalledTimes(1);

    // Collapse.
    await userEvent.click(screen.getByRole('button', { expanded: true }));

    // Switch filter while collapsed.
    rerender(<MessageRow message={baseMessage} filter="all" loadHits={loader} />);
    // Loader should NOT have been called again yet (still collapsed).
    expect(loader).toHaveBeenCalledTimes(1);

    // Re-expand → loader called with the new filter.
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByText(/no opens yet/i);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith('m1', 'all');
  });
});
