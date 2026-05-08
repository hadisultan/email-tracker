// Minimal service worker for the email-tracker dashboard.
//
// Two responsibilities:
//   1. push events  → showNotification({title, body, data: {messageId, dashboardUrl}})
//   2. notificationclick → focus an existing tab on data.dashboardUrl, or
//      open a new one. Falls back to '/' when the payload is malformed.
//
// We do NOT cache anything — the dashboard is fetched fresh from the
// Netlify CDN. This keeps the SW boring and reduces the surface for
// stale-asset bugs.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'Email tracker', body: event.data.text() };
    }
  }
  const title = payload.title || 'Email tracker';
  const options = {
    body: payload.body || 'A tracked email was just opened.',
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    data: payload.data || {},
    tag: payload.data && payload.data.messageId ? `msg:${payload.data.messageId}` : undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Reject anything that isn't a same-origin absolute path. Strings that
// start with `//` are protocol-relative — the browser treats them as
// cross-origin (e.g. `//attacker.com` → `https://attacker.com`), so a
// poisoned push payload could phish via clients.openWindow. Only allow
// `/...` paths, never full URLs from the payload.
function isSafeRelativePath(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.startsWith('/')
    && !value.startsWith('//')
  );
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requested = event.notification.data && event.notification.data.dashboardUrl;
  const target = isSafeRelativePath(requested) ? requested : '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (!('focus' in client)) continue;
          // Compare pathnames rather than endsWith() so `/messages/m-1`
          // doesn't accidentally match `/admin/messages/m-1` via the
          // suffix collision.
          let clientPath;
          try {
            clientPath = new URL(client.url).pathname;
          } catch {
            continue;
          }
          if (clientPath === target) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(target);
        }
        return undefined;
      }),
  );
});
