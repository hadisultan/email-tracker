// Stacked health banner. Reads the four signals from the system_health
// view and renders one sub-banner per unhealthy signal so the user can
// see and act on each issue independently.
//
// Thresholds (per plan R22):
//   - last_poll_success_at older than 30 minutes → poll is stalled
//   - last_push_success_at older than 24 hours   → push delivery may be broken
//                                                  (only flagged if a sub exists)
//   - oauth_expiry passed                        → re-authorize required
//   - last_pixel_hit_at older than 7 days        → no opens yet (informational)

export interface SystemHealth {
  user_id: string;
  last_pixel_hit_at: string | null;
  last_poll_success_at: string | null;
  oauth_expiry: string | null;
  last_push_success_at: string | null;
}

interface Props {
  health: SystemHealth | null;
  hasPushSubscription: boolean;
  onReauthorize?: () => void;
  onResubscribe?: () => void;
}

const POLL_STALE_MS = 30 * 60_000;
const PUSH_STALE_MS = 24 * 60 * 60_000;
const PIXEL_HIT_STALE_MS = 7 * 24 * 60 * 60_000;

function ageMs(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return now - ts;
}

type IssueSeverity = 'error' | 'info';

interface Issue {
  id: string;
  message: string;
  cta?: { label: string; onClick: () => void };
  severity: IssueSeverity;
}

function buildIssues(props: Props, now: number): Issue[] {
  const { health, hasPushSubscription, onReauthorize, onResubscribe } = props;
  const issues: Issue[] = [];
  if (!health) return issues;

  // Poll staleness — no manual CTA (cron-job.org is the only trigger).
  const pollAge = ageMs(health.last_poll_success_at, now);
  if (pollAge === null) {
    issues.push({
      id: 'poll-never',
      severity: 'error',
      message: 'No successful poll on record yet. Verify cron-job.org is configured.',
    });
  } else if (pollAge > POLL_STALE_MS) {
    const mins = Math.floor(pollAge / 60_000);
    issues.push({
      id: 'poll-stale',
      severity: 'error',
      message: `Last successful poll was ${mins} minutes ago. cron-job.org may be misconfigured or the function is failing.`,
    });
  }

  // OAuth expiry.
  if (health.oauth_expiry) {
    const expiresAt = new Date(health.oauth_expiry).getTime();
    if (expiresAt < now) {
      issues.push({
        id: 'oauth-expired',
        severity: 'error',
        message: 'Gmail authorization has expired. The poller cannot fetch new history events until you re-authorize.',
        cta: onReauthorize ? { label: 'Re-authorize', onClick: onReauthorize } : undefined,
      });
    }
  } else {
    issues.push({
      id: 'oauth-missing',
      severity: 'error',
      message: 'Gmail OAuth is not configured. Sign in to grant Gmail History API access.',
      cta: onReauthorize ? { label: 'Authorize Gmail', onClick: onReauthorize } : undefined,
    });
  }

  // Push delivery staleness — only flag when a subscription exists.
  if (hasPushSubscription) {
    const pushAge = ageMs(health.last_push_success_at, now);
    if (pushAge === null) {
      issues.push({
        id: 'push-never',
        severity: 'error',
        message: 'You are subscribed to push notifications, but no push has been delivered yet.',
        cta: onResubscribe ? { label: 'Re-subscribe', onClick: onResubscribe } : undefined,
      });
    } else if (pushAge > PUSH_STALE_MS) {
      issues.push({
        id: 'push-stale',
        severity: 'error',
        message: 'No successful push notification in the last 24 hours. Your subscription may have expired on the device.',
        cta: onResubscribe ? { label: 'Re-subscribe', onClick: onResubscribe } : undefined,
      });
    }
  }

  // Pixel-hit staleness — informational. Only flag when there is at
  // least one open on record but it's been quiet for a week. Skipping
  // the "never" case avoids alarming users on first sign-in before any
  // tracked email has actually been opened.
  const pixelHitAge = ageMs(health.last_pixel_hit_at, now);
  if (pixelHitAge !== null && pixelHitAge > PIXEL_HIT_STALE_MS) {
    const days = Math.floor(pixelHitAge / (24 * 60 * 60_000));
    issues.push({
      id: 'pixel-hit-stale',
      severity: 'info',
      message: `No tracked email has been opened in ${days} days. If you're sending tracked email, the pixel endpoint may be unreachable.`,
    });
  }

  return issues;
}

// Return the colour palette for a given issue severity. Errors render in
// red so they're scanned first; info renders in blue so the user can tell
// it's not actionable on the same axis as auth/push breakage.
function paletteFor(severity: IssueSeverity): {
  background: string;
  border: string;
  color: string;
  ctaBg: string;
} {
  if (severity === 'info') {
    return { background: '#eff6ff', border: '#bfdbfe', color: '#1e40af', ctaBg: '#1e40af' };
  }
  return { background: '#fef2f2', border: '#fecaca', color: '#991b1b', ctaBg: '#991b1b' };
}

export function HealthBanner(props: Props) {
  const issues = buildIssues(props, Date.now());
  if (issues.length === 0) return null;
  return (
    <section
      role="alert"
      aria-label="System health issues"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginBottom: 16,
      }}
      data-testid="health-banner"
    >
      {issues.map((issue) => {
        const palette = paletteFor(issue.severity);
        return (
          <div
            key={issue.id}
            data-testid={`health-issue-${issue.id}`}
            data-severity={issue.severity}
            style={{
              background: palette.background,
              border: `1px solid ${palette.border}`,
              color: palette.color,
              borderRadius: 6,
              padding: '10px 12px',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ flex: 1 }}>{issue.message}</span>
            {issue.cta && (
              <button
                onClick={issue.cta.onClick}
                style={{
                  minHeight: 44,
                  minWidth: 44,
                  padding: '6px 12px',
                  background: palette.ctaBg,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                {issue.cta.label}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
