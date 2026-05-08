// Tooltip-style notice when a Gmail recipient is on the message and
// the open count looks suspiciously low. Gmail's image proxy caches
// the pixel, so repeat opens often don't generate new hits.

interface Props {
  recipients: string[];
  hitCount: number;
}

function hasGmailRecipient(recipients: string[]): boolean {
  return recipients.some((r) => /@gmail\.com$/i.test(r));
}

export function GmailCachingNotice({ recipients, hitCount }: Props) {
  if (!hasGmailRecipient(recipients)) return null;
  if (hitCount > 1) return null;
  return (
    <p
      role="note"
      style={{
        margin: '4px 0 0',
        fontSize: '0.8rem',
        color: '#475569',
      }}
    >
      <span aria-hidden="true">ℹ </span>
      Gmail caches the tracking pixel after the first open, so repeat opens may
      not register.
    </p>
  );
}
