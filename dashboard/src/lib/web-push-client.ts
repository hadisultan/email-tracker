// Web Push subscription helper.
//
// Subscribe flow:
//   1. Register /sw.js if not already controlling.
//   2. Permission.request().
//   3. Fetch (or read cached) VAPID public key from /api/vapid-public-key.
//   4. pushManager.subscribe({applicationServerKey, userVisibleOnly: true}).
//   5. POST {endpoint, keys} to /api/push-subscribe.
//
// VAPID key cache lives in localStorage with a 24h TTL so a server-side
// rotation can't permanently lock out devices that loaded an old key.

import { getVapidPublicKey, postPushSubscription } from './api.js';

const VAPID_CACHE_KEY = 'et:vapid-public-key';
const VAPID_TTL_MS = 24 * 60 * 60_000;

interface VapidCache {
  key: string;
  fetched_at: number;
}

function readCachedVapidKey(): string | null {
  try {
    const raw = localStorage.getItem(VAPID_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VapidCache;
    if (!parsed.key || typeof parsed.fetched_at !== 'number') return null;
    if (Date.now() - parsed.fetched_at > VAPID_TTL_MS) return null;
    return parsed.key;
  } catch {
    return null;
  }
}

function writeCachedVapidKey(key: string): void {
  try {
    const value: VapidCache = { key, fetched_at: Date.now() };
    localStorage.setItem(VAPID_CACHE_KEY, JSON.stringify(value));
  } catch {
    /* localStorage disabled — fine, we'll just refetch */
  }
}

async function fetchVapidKey(): Promise<string> {
  const cached = readCachedVapidKey();
  if (cached) return cached;
  const { publicKey } = await getVapidPublicKey();
  writeCachedVapidKey(publicKey);
  return publicKey;
}

// Convert URL-safe base64 VAPID key into the BufferSource the
// pushManager.subscribe API requires. We allocate a fresh ArrayBuffer
// (not a SharedArrayBuffer) because lib.dom typings reject the latter.
function urlBase64ToBufferSource(b64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const standard = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(standard);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported in this browser');
  }
  const existing = await navigator.serviceWorker.getRegistration('/sw.js');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js');
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function subscribeToPush(): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported in this browser');
  }
  const reg = await ensureServiceWorker();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was denied');
  }
  const vapidKey = await fetchVapidKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBufferSource(vapidKey),
  });
  await postPushSubscription({
    endpoint: sub.endpoint,
    keys: {
      p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
      auth: arrayBufferToBase64(sub.getKey('auth')),
    },
  });
  return sub;
}

export async function unsubscribeFromPush(): Promise<boolean> {
  const sub = await getCurrentSubscription();
  if (!sub) return false;
  return sub.unsubscribe();
}
