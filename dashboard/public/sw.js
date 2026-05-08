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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.dashboardUrl) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client && client.url.endsWith(target)) {
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
