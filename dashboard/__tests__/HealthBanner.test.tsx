import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HealthBanner, type SystemHealth } from '../src/components/HealthBanner.js';

const NOW = new Date('2025-01-15T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const HEALTHY_HEALTH: SystemHealth = {
  user_id: 'u',
  last_pixel_hit_at: new Date(NOW - 5 * 60_000).toISOString(),
  last_poll_success_at: new Date(NOW - 5 * 60_000).toISOString(),
  oauth_expiry: new Date(NOW + 60 * 60_000).toISOString(),
  last_push_success_at: new Date(NOW - 10 * 60_000).toISOString(),
};

describe('HealthBanner', () => {
  it('renders nothing when health is null', () => {
    const { container } = render(
      <HealthBanner health={null} hasPushSubscription={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when every signal is healthy', () => {
    const { container } = render(
      <HealthBanner health={HEALTHY_HEALTH} hasPushSubscription={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('flags poll staleness when last_poll_success_at is older than 30 minutes', () => {
    const stale: SystemHealth = {
      ...HEALTHY_HEALTH,
      last_poll_success_at: new Date(NOW - 45 * 60_000).toISOString(),
    };
    render(<HealthBanner health={stale} hasPushSubscription={false} />);
    const issue = screen.getByTestId('health-issue-poll-stale');
    expect(issue).toHaveTextContent(/Last successful poll was 45 minutes ago/i);
    // No CTA on poll staleness — cron-job.org is the only trigger.
    expect(issue.querySelector('button')).toBeNull();
  });

  it('flags poll never when last_poll_success_at is null', () => {
    const stale: SystemHealth = { ...HEALTHY_HEALTH, last_poll_success_at: null };
    render(<HealthBanner health={stale} hasPushSubscription={false} />);
    expect(screen.getByTestId('health-issue-poll-never')).toBeInTheDocument();
  });

  it('flags expired OAuth and surfaces a Re-authorize CTA', () => {
    const expired: SystemHealth = {
      ...HEALTHY_HEALTH,
      oauth_expiry: new Date(NOW - 10_000).toISOString(),
    };
    const onReauth = vi.fn();
    render(
      <HealthBanner
        health={expired}
        hasPushSubscription={false}
        onReauthorize={onReauth}
      />,
    );
    const issue = screen.getByTestId('health-issue-oauth-expired');
    expect(issue).toHaveTextContent(/Gmail authorization has expired/i);
    fireEvent.click(screen.getByRole('button', { name: /Re-authorize/i }));
    expect(onReauth).toHaveBeenCalledOnce();
  });

  it('flags missing OAuth when oauth_expiry is null', () => {
    const missing: SystemHealth = { ...HEALTHY_HEALTH, oauth_expiry: null };
    render(<HealthBanner health={missing} hasPushSubscription={false} />);
    expect(screen.getByTestId('health-issue-oauth-missing')).toBeInTheDocument();
  });

  it('flags stale push only when a subscription exists', () => {
    const stalePush: SystemHealth = {
      ...HEALTHY_HEALTH,
      last_push_success_at: new Date(NOW - 30 * 60 * 60_000).toISOString(),
    };

    // No subscription → push staleness is suppressed.
    const { rerender } = render(
      <HealthBanner health={stalePush} hasPushSubscription={false} />,
    );
    expect(screen.queryByTestId('health-issue-push-stale')).toBeNull();

    // With subscription → push staleness shows up.
    rerender(<HealthBanner health={stalePush} hasPushSubscription={true} />);
    expect(screen.getByTestId('health-issue-push-stale')).toBeInTheDocument();
  });

  it('flags push-never when subscribed but no push has ever delivered', () => {
    const neverPushed: SystemHealth = {
      ...HEALTHY_HEALTH,
      last_push_success_at: null,
    };
    const onResub = vi.fn();
    render(
      <HealthBanner
        health={neverPushed}
        hasPushSubscription={true}
        onResubscribe={onResub}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Re-subscribe/i }));
    expect(onResub).toHaveBeenCalledOnce();
  });

  it('flags pixel-hit staleness as informational when last open is older than 7 days', () => {
    const stale: SystemHealth = {
      ...HEALTHY_HEALTH,
      last_pixel_hit_at: new Date(NOW - 10 * 24 * 60 * 60_000).toISOString(),
    };
    render(<HealthBanner health={stale} hasPushSubscription={false} />);
    const issue = screen.getByTestId('health-issue-pixel-hit-stale');
    expect(issue).toHaveTextContent(/No tracked email has been opened in 10 days/i);
    // Severity is informational, not error — surfaced via the data-severity
    // attribute so the palette diverges from the red error banners.
    expect(issue).toHaveAttribute('data-severity', 'info');
    // No CTA — user can't manually fix this; it's diagnostic only.
    expect(issue.querySelector('button')).toBeNull();
  });

  it('does not flag pixel-hit staleness when last open is within 7 days', () => {
    const recent: SystemHealth = {
      ...HEALTHY_HEALTH,
      last_pixel_hit_at: new Date(NOW - 6 * 24 * 60 * 60_000).toISOString(),
    };
    render(<HealthBanner health={recent} hasPushSubscription={false} />);
    expect(screen.queryByTestId('health-issue-pixel-hit-stale')).toBeNull();
  });

  it('does not flag pixel-hit staleness when last_pixel_hit_at is null (no opens yet)', () => {
    const never: SystemHealth = { ...HEALTHY_HEALTH, last_pixel_hit_at: null };
    render(<HealthBanner health={never} hasPushSubscription={false} />);
    // Skipping the "never" case avoids alarming users on first sign-in
    // before any tracked email has actually been opened.
    expect(screen.queryByTestId('health-issue-pixel-hit-stale')).toBeNull();
  });

  it('stacks multiple unhealthy signals as separate sub-banners', () => {
    const broken: SystemHealth = {
      ...HEALTHY_HEALTH,
      last_poll_success_at: new Date(NOW - 60 * 60_000).toISOString(),
      oauth_expiry: new Date(NOW - 10_000).toISOString(),
      last_push_success_at: null,
    };
    render(
      <HealthBanner
        health={broken}
        hasPushSubscription={true}
        onReauthorize={() => {}}
        onResubscribe={() => {}}
      />,
    );
    expect(screen.getByTestId('health-issue-poll-stale')).toBeInTheDocument();
    expect(screen.getByTestId('health-issue-oauth-expired')).toBeInTheDocument();
    expect(screen.getByTestId('health-issue-push-never')).toBeInTheDocument();
    // Each issue has its own CTA where applicable.
    expect(screen.getByRole('button', { name: /Re-authorize/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-subscribe/i })).toBeInTheDocument();
  });
});
