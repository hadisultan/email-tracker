// Inline notice rendered on a MessageRow when there's more than one
// recipient on the original send. Open events on multi-recipient
// messages cannot be attributed to a specific recipient because every
// recipient receives the same tracking pixel URL — see plan R4.

export function MultiRecipientNotice({ recipientCount }: { recipientCount: number }) {
  if (recipientCount < 2) return null;
  return (
    <p
      role="note"
      style={{
        margin: '4px 0 0',
        padding: '6px 10px',
        background: '#f1f5f9',
        color: '#334155',
        borderRadius: 4,
        fontSize: '0.85rem',
      }}
    >
      <strong>{recipientCount} recipients —</strong> open events on multi-recipient
      sends cannot be attributed to a specific recipient. Could be any of them.
    </p>
  );
}
