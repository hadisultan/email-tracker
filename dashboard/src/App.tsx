// Top-level dashboard router + auth gate.
//
// Subscribes to the supabase auth state. While loading, renders a tiny
// splash. On no-session, shows SignIn. On session present:
//   - If session.provider_token is set (just-completed OAuth redirect),
//     POST it to /api/oauth-finalize so the server stores the refresh
//     token before the URL hash drops it.
//   - Otherwise route between /messages (default) and /setup.

import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './lib/supabase.js';
import { ApiError, finalizeOAuth } from './lib/api.js';
import { SignIn } from './pages/SignIn.js';
import { Messages } from './pages/Messages.js';
import { Setup } from './pages/Setup.js';

interface AuthState {
  session: Session | null;
  loaded: boolean;
  authError: string | null;
}

export function App() {
  const sb = getSupabase();
  const [auth, setAuth] = useState<AuthState>({
    session: null,
    loaded: false,
    authError: null,
  });

  useEffect(() => {
    void sb.auth.getSession().then(({ data }) => {
      setAuth({ session: data.session, loaded: true, authError: null });
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      setAuth((prev) => ({ ...prev, session, loaded: true }));
    });
    return () => sub.subscription.unsubscribe();
  }, [sb]);

  // After a successful Supabase Google OAuth round-trip, the session
  // briefly carries provider_token / provider_refresh_token. Mirror
  // them into gmail_credentials so the poller can use the refresh
  // token forever even when Supabase rotates the provider access
  // token.
  useEffect(() => {
    const session = auth.session;
    if (!session?.provider_token) return;
    let cancelled = false;
    void (async () => {
      try {
        await finalizeOAuth({
          provider_token: session.provider_token!,
          provider_refresh_token: session.provider_refresh_token ?? null,
          expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
        });
        if (!cancelled) {
          setAuth((prev) => ({ ...prev, authError: null }));
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          // signOut can fail if Supabase auth is offline or the session
          // is already corrupt. Log it but still clear local auth state
          // so the user sees the error and isn't stuck in a half-signed-in
          // loop on refresh.
          try {
            await sb.auth.signOut();
          } catch (signOutErr) {
            console.error(
              JSON.stringify({
                source: 'oauth-finalize',
                stage: 'signOut',
                err: (signOutErr as Error).message,
              }),
            );
          }
          setAuth({
            session: null,
            loaded: true,
            authError:
              'This is a personal tool — only the configured owner email may sign in.',
          });
          return;
        }
        setAuth((prev) => ({ ...prev, authError: (err as Error).message }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.session, sb]);

  if (!auth.loaded) {
    return (
      <main style={{ padding: 32, textAlign: 'center', color: '#475569' }}>
        Loading…
      </main>
    );
  }

  if (!auth.session) {
    return (
      <BrowserRouter>
        {auth.authError && (
          <p
            role="alert"
            style={{
              maxWidth: 480,
              margin: '12px auto 0',
              padding: '10px 12px',
              background: '#fef2f2',
              color: '#991b1b',
              border: '1px solid #fecaca',
              borderRadius: 6,
            }}
          >
            {auth.authError}
          </p>
        )}
        <Routes>
          <Route path="*" element={<SignIn />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/messages" replace />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/messages/:id" element={<Messages />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Navigate to="/messages" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
