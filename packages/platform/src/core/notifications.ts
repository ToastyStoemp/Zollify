import { computed, ref } from 'vue';
import type { AppNotification } from '@zollify/shared';
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

let loading: Promise<void> | null = null;

/** Fetches the list; `announce` toasts what arrived since the last fetch. */
export function loadNotifications(announce = false): Promise<void> {
  if (!getAccount()) return Promise.resolve();
  loading ??= (async () => {
    try {
      const known = new Set(notifications.value.map((n) => n.id));
      const res = (await authFetch('/notifications')) as { notifications: AppNotification[] };
      // Low-level news never pops up; it waits in the list.
      const fresh = res.notifications.filter((n) => !known.has(n.id) && n.readAt == null && n.level !== 'low');
      notifications.value = res.notifications;
      if (announce) for (const n of fresh.slice(0, 3)) createShellUi('core').toast(n.title, { kind: n.level === 'urgent' ? 'warning' : 'info', timeoutMs: n.level === 'urgent' ? 10000 : 6000 });
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
