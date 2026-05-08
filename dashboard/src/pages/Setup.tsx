// Setup page — pairing-code generator, push subscribe button, OAuth
// status row. Also surfaces the manual sign-out action.

import { useEffect, useState } from 'react';
import { ApiError, createPairingCode } from '../lib/api.js';
import { getSupabase } from '../lib/supabase.js';
import {
  getCurrentSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/web-push-client.js';

interface PairCode {
  code: string;
  expires_at: string;
}

export function Setup() {
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isPushSupported()) {
      setPushSubscribed(false);
      return;
    }
    getCurrentSubscription().then((s) => setPushSubscribed(s !== null));
  }, []);

  async function handleGenerateCode() {
    setPairBusy(true);
    setPairError(null);
    try {
      const code = await createPairingCode();
      setPairCode(code);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.message} (${err.code ?? err.status})`
          : (err as Error).message;
      setPairError(msg);
    } finally {
      setPairBusy(false);
    }
  }

  async function handleSubscribePush() {
    setPushBusy(true);
    setPushError(null);
    try {
      await subscribeToPush();
      setPushSubscribed(true);
    } catch (err) {
      setPushError((err as Error).message);
    } finally {
      setPushBusy(false);
    }
  }

  async function handleUnsubscribePush() {
    setPushBusy(true);
    setPushError(null);
    try {
      await unsubscribeFromPush();
      setPushSubscribed(false);
    } catch (err) {
      setPushError((err as Error).message);
    } finally {
      setPushBusy(false);
    }
  }

  async function handleSignOut() {
    await getSupabase().auth.signOut();
    window.location.assign('/');
  }

  async function handleCopyCode() {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(pairCode.code);
    } catch {
      /* ignore — user can manually copy */
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '16px' }}>
      <h1>Setup</h1>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Pair the Chrome extension</h2>
        <p style={pStyle}>
          Generate a one-time code, then paste it into the Email Tracker
          extension popup. Codes are valid for 10 minutes.
        </p>
        <button
          onClick={handleGenerateCode}
          disabled={pairBusy}
          style={primaryButtonStyle}
        >
          {pairBusy ? 'Generating…' : 'Generate pairing code'}
        </button>
        {pairError && <p style={errorStyle}>{pairError}</p>}
        {pairCode && (
          <div style={codeBlockStyle}>
            <code
              style={{
                fontFamily: 'monospace',
                fontSize: '1.2rem',
                letterSpacing: '0.05em',
                userSelect: 'all',
              }}
            >
              {pairCode.code}
            </code>
            <button
              onClick={handleCopyCode}
              style={{ ...secondaryButtonStyle, marginLeft: 8 }}
            >
              Copy
            </button>
            <p style={{ ...pStyle, fontSize: '0.8rem', marginTop: 6 }}>
              Expires {new Date(pairCode.expires_at).toLocaleString()}.
            </p>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Push notifications</h2>
        <p style={pStyle}>
          Get a notification on this device when a tracked email is opened.
        </p>
        {pushSubscribed === null && <p style={pStyle}>Checking…</p>}
        {pushSubscribed === false && (
          <button
            onClick={handleSubscribePush}
            disabled={pushBusy || !isPushSupported()}
            style={primaryButtonStyle}
          >
            {pushBusy ? 'Subscribing…' : 'Enable notifications'}
          </button>
        )}
        {pushSubscribed === true && (
          <button
            onClick={handleUnsubscribePush}
            disabled={pushBusy}
            style={secondaryButtonStyle}
          >
            {pushBusy ? 'Unsubscribing…' : 'Disable notifications on this device'}
          </button>
        )}
        {!isPushSupported() && (
          <p style={pStyle}>
            Push notifications aren&apos;t supported in this browser.
          </p>
        )}
        {pushError && <p style={errorStyle}>{pushError}</p>}
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Account</h2>
        <button onClick={handleSignOut} style={secondaryButtonStyle}>
          Sign out
        </button>
      </section>
    </main>
  );
}

const sectionStyle = {
  margin: '16px 0',
  padding: 16,
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  background: '#fff',
} as const;

const h2Style = { marginTop: 0, marginBottom: 8, fontSize: '1.1rem' } as const;
const pStyle = { color: '#475569', margin: '0 0 8px' } as const;
const errorStyle = { color: '#b91c1c', marginTop: 8, fontSize: '0.9rem' } as const;
const codeBlockStyle = {
  marginTop: 12,
  padding: 12,
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
} as const;
const primaryButtonStyle = {
  minHeight: 44,
  minWidth: 44,
  padding: '10px 16px',
  background: '#0f172a',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  fontWeight: 600,
  cursor: 'pointer',
} as const;
const secondaryButtonStyle = {
  minHeight: 44,
  minWidth: 44,
  padding: '10px 16px',
  background: '#fff',
  color: '#0f172a',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  fontWeight: 600,
  cursor: 'pointer',
} as const;
