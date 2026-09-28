import { aidevApi } from '@/modules/aidev-router';

/**
 * Web push for the mobile PWA (C-06): subscribe this device through the service worker registered
 * in main.tsx and hand the subscription to the gateway. iOS delivers web push only to an app added
 * to the Home Screen (iOS 16.4+), so that case is reported instead of failing silently.
 */
export type PushState = 'unsupported' | 'needs_install' | 'denied' | 'off' | 'on';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

function urlBase64ToUint8Array(base64: string) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function registration() {
  return navigator.serviceWorker.getRegistration('/m/') ?? navigator.serviceWorker.ready;
}

/** Used by SettingsScreen to show the notification row. */
export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos() && !isStandalone() ? 'needs_install' : 'unsupported';
  if (isIos() && !isStandalone()) return 'needs_install';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

/** Used by SettingsScreen: asks for permission (must run from a tap), subscribes, registers with the gateway. */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  const { publicKey } = await aidevApi.pushKey();
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await aidevApi.pushSubscribe(sub.toJSON());
  return 'on';
}

/** Used by SettingsScreen: unsubscribes this device here and at the gateway. */
export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await aidevApi.pushUnsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'off';
}
