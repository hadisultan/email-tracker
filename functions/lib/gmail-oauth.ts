// Gmail OAuth refresh-token exchange helper.
// Used by the poller (Unit 7) to obtain a fresh access token before each
// History API call. Kept dependency-free so it can run in any Netlify
// runtime.

export interface ExchangeResult {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export async function exchangeRefreshToken(refreshToken: string): Promise<ExchangeResult> {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_OAUTH_CLIENT_ID/SECRET not set');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`gmail token exchange failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new Error('gmail token response missing access_token or expires_in');
  }
  return {
    accessToken: json.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + json.expires_in,
  };
}
