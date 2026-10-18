import { computed, ref } from 'vue';
import type { AppNotification } from '@zollify/shared';
import { isNative } from '../native';
import { authFetch, getAccount } from '../session';
import { createShellUi } from '../shell-ui';

/**
 * In-app notifications, shown under the shell's bell.
 *
 * Raised server-side (a store booking an artist's setup, the artist
 * answering) and announced over the live channel with a doorbell; this pulls
 * the list over HTTP. Nothing is stored on the device - the bell is only
 * ever as current as the last fetch, which is fine for notes, not data.
 */

export const notifications = ref<AppNotification[]>([]);
/** What the bell counts: unread notes that ask for attention. Low-level news (items shared) is listed, not counted. */
export const unreadNotifications = computed(() => notifications.value.filter((n) => n.readAt == null && n.level !== 'low').length);
/** Unread notes that need an answer soon (a setup to confirm): the bell turns red for these. */
export const urgentNotifications = computed(() => notifications.value.filter((n) => n.readAt == null && n.level === 'urgent').length);
/** Anything unread at all, low-level news included. */
export const anyUnreadNotifications = computed(() => notifications.value.some((n) => n.readAt == null));

// ── What this device asks to be told, on its own screen ─────────────────────
/**
 * Categories (WEBHOOK_EVENTS ids) this device wants as a toast, and as a
 * system notification where the browser has them. Kept on the device, and
 * told to the server, which raises the reminders (yesterday's sales, a month
 * closing) only for accounts where some device asked.
 */
const KINDS_KEY = 'core.notifyKinds';
const readKinds = (): string[] => {
  try {
    return (JSON.parse(localStorage.getItem(KINDS_KEY) ?? '[]') as string[]) ?? [];
  } catch {
    return [];
  }
};
export const notifyKinds = ref<string[]>(readKinds());

// ── System notifications on Android ─────────────────────────────────────────
// Capacitor's WebView has no Notification API; the app posts them through
// @capacitor/local-notifications. Loaded on demand so the web bundle stays out of it.
const localNotifications = () => import('@capacitor/local-notifications').then((m) => m.LocalNotifications);
/** The Android permission, kept here so `systemNotificationState` can answer without a round trip to the plugin. */
let nativePermission: NotificationPermission | null = null;
const toPermission = (state: string): NotificationPermission => (state === 'granted' || state === 'denied' ? state : 'default');
if (isNative()) {
  localNotifications()
    .then((ln) => ln.checkPermissions())
    .then((r) => (nativePermission = toPermission(r.display)))
    .catch(() => undefined);
}
/** A stable int for the plugin from the note's id: Android keys notifications by number, and the same note must replace itself. */
const notificationNumber = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h;
};

/** Saves the choice here and on the server, and asks for permission the first time something is on. */
export async function setNotifyKinds(kinds: string[]): Promise<void> {
  notifyKinds.value = kinds;
  try {
    localStorage.setItem(KINDS_KEY, JSON.stringify(kinds));
  } catch {
    /* no storage: the server copy still steers the reminders */
  }
  if (kinds.length) {
    if (isNative()) {
      try {
        nativePermission = toPermission((await (await localNotifications()).requestPermissions()).display);
      } catch {
        /* an app without the plugin: toasts only */
      }
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission().catch(() => undefined);
  }
  await authFetch('/devices/me/notifications', { method: 'PUT', body: JSON.stringify({ kinds, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }) });
}

/** Whether this device will show system notifications: granted, denied, or not asked (null where it has none). */
export const systemNotificationState = (): NotificationPermission | null => {
  if (isNative()) return nativePermission;
  return typeof Notification !== 'undefined' ? Notification.permission : null;
};

function showOnScreen(n: AppNotification): void {
  createShellUi('core').toast(n.title, { kind: n.level === 'urgent' ? 'warning' : 'info', timeoutMs: n.level === 'urgent' ? 10000 : 6000 });
  // A system notification only while the app is in the background: in front, the toast already said it.
  if (document.visibilityState === 'visible') return;
  if (isNative()) {
    if (nativePermission !== 'granted') return;
    localNotifications()
      .then((ln) => ln.schedule({ notifications: [{ id: notificationNumber(n.id), title: n.title, body: n.body }] }))
      .catch(() => undefined);
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(n.title, { body: n.body, tag: n.id });
  } catch {
    /* some browsers only allow these from a service worker */
  }
}

let loading: Promise<void> | null = null;

/** Fetches the list; `announce` toasts what arrived since the last fetch. */
export function loadNotifications(announce = false): Promise<void> {
  if (!getAccount()) return Promise.resolve();
  loading ??= (async () => {
    try {
      const known = new Set(notifications.value.map((n) => n.id));
      const res = (await authFetch('/notifications')) as { notifications: AppNotification[] };
      // Low-level news never pops up unless this device asked for its kind; it waits in the list.
      const asked = new Set(notifyKinds.value);
      const fresh = res.notifications.filter((n) => !known.has(n.id) && n.readAt == null && (n.level !== 'low' || (n.kind && asked.has(n.kind))));
      notifications.value = res.notifications;
      if (announce) for (const n of fresh.slice(0, 3)) showOnScreen(n);
    } catch {
      /* offline: the bell keeps what it had */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Marks some read, or all of them when no ids are given. */
export async function markNotificationsRead(ids?: string[]): Promise<void> {
  const now = Date.now();
  notifications.value = notifications.value.map((n) => (!ids || ids.includes(n.id)) && n.readAt == null ? { ...n, readAt: now } : n);
  try {
    await authFetch('/notifications/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) });
  } catch {
    /* read again next time - harmless */
  }
}

export function resetNotifications(): void {
  notifications.value = [];
}
