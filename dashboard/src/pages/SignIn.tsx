// SignIn page — single Google OAuth button.
//
// Supabase signInWithOAuth with the Gmail scopes from Unit 4 plus
// access_type=offline + prompt=consent so Google returns a refresh
// token. After the OAuth redirect lands back on /, App.tsx detects the
// session and posts the provider tokens to /api/oauth-finalize.

import { useState } from 'react';
import { getSupabase } from '../lib/supabase.js';

const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
].join(' ');

export function SignIn() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    try {
      const sb = getSupabase();
      const { error: oauthErr } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
          scopes: GMAIL_SCOPES,
          redirectTo: window.location.origin,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });
      if (oauthErr) throw oauthErr;
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 480,
        margin: '0 auto',
        padding: '32px 16px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ marginBottom: 8 }}>Email Tracker</h1>
      <p style={{ color: '#475569', marginBottom: 24 }}>
        A personal Mailsuite-style tool. Sign in with your Google account to
        get started.
      </p>
      <button
        onClick={handleSignIn}
        disabled={loading}
        style={{
          minHeight: 44,
          minWidth: 44,
          padding: '12px 24px',
          background: '#0f172a',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontSize: '1rem',
          fontWeight: 600,
          cursor: loading ? 'wait' : 'pointer',
          width: '100%',
        }}
      >
        {loading ? 'Redirecting…' : 'Sign in with Google'}
      </button>
      {error && (
        <p style={{ color: '#b91c1c', marginTop: 16, fontSize: '0.9rem' }}>
          {error}
        </p>
      )}
      <p style={{ marginTop: 24, fontSize: '0.8rem', color: '#94a3b8' }}>
        This is a personal tool — only the configured owner email may sign in.
      </p>
    </main>
  );
}
