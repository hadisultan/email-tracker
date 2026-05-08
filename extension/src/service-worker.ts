// Background service worker — thin auth-state holder.
//
// MV3 service workers are evicted after ~30s idle. This means any
// in-memory state must be re-derivable from `chrome.storage.local` on
// each invocation. We do *not* hold the service token in module scope.
//
// In U6a the SW handles two messages from the popup and (later) the
// content script:
//   - 'auth/get'    — read the stored service token
//   - 'auth/clear'  — wipe the stored service token (will be called by
//                     U6b/U6c when an authenticated request returns 401)
//
// API calls themselves do NOT go through the SW — they run inline in
// the calling context (popup or content script) so an in-flight Promise
// never dies when the SW is evicted mid-call.

interface AuthMessage {
  type: 'auth/get' | 'auth/clear';
}

const TOKEN_KEY = 'serviceToken';

chrome.runtime.onInstalled.addListener((details) => {
  console.log('email-tracker SW installed:', details.reason);
});

chrome.runtime.onMessage.addListener(
  (msg: AuthMessage | undefined, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return false;

    if (msg.type === 'auth/get') {
      void chrome.storage.local
        .get(TOKEN_KEY)
        .then((d) => {
          const v = (d as Record<string, unknown>)[TOKEN_KEY];
          sendResponse({ token: typeof v === 'string' ? v : null });
        })
        .catch((err: unknown) => {
          console.warn('auth/get storage failure:', err);
          sendResponse({ token: null, error: 'storage_error' });
        });
      return true;
    }

    if (msg.type === 'auth/clear') {
      void chrome.storage.local
        .remove(TOKEN_KEY)
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => {
          console.warn('auth/clear storage failure:', err);
          sendResponse({ ok: false, error: 'storage_error' });
        });
      return true;
    }

    return false;
  },
);

