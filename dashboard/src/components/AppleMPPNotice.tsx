// Yellow inline banner for Apple Mail Privacy Protection.
//
// MPP pre-fetches tracking pixels server-side regardless of whether
// the recipient ever opens the message. This means an "open" event
// from an MPP-routed mail provider isn't a true open. We surface this
// to the user so they don't read too much into it (Open Question D1
// deferral — see plan).

interface Props {
  recipients: string[];
  proxyLabels: string[]; // proxy_label values across this message's hits
}

const APPLE_DOMAINS = /@(icloud|me|mac)\.com$/i;

function hasAppleRecipient(recipients: string[]): boolean {
  return recipients.some((r) => APPLE_DOMAINS.test(r));
}

function hasAppleProxyLabel(proxyLabels: string[]): boolean {
  return proxyLabels.some((p) => p === 'apple_mail_mpp');
}

export function AppleMPPNotice({ recipients, proxyLabels }: Props) {
  if (!hasAppleRecipient(recipients) && !hasAppleProxyLabel(proxyLabels)) return null;
  return (
    <p
      role="note"
      style={{
        margin: '4px 0 0',
        padding: '6px 10px',
        background: '#fef9c3',
        color: '#854d0e',
        borderRadius: 4,
        fontSize: '0.85rem',
      }}
    >
      <strong>Apple Mail Privacy Protection:</strong> this recipient&apos;s mail
      provider may pre-fetch tracking images automatically. The &quot;open&quot;
      shown above could have happened without the recipient actually viewing
      the message.
    </p>
  );
}
