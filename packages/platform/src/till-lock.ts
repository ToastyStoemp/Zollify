import { ref, shallowRef } from 'vue';
import { ROLE_RANK, type AccountSnapshot, type HttpError, type Role } from '@zollify/sdk';
import type { TokenResponse } from '@zollify/shared';
import { deviceId } from './core/device';
import { syncNow } from './core/sync';
import { authFetch, deviceFetch, dropPerson, getAccount, getDeviceAccount, onPersonSessionLost, personFrom, setActivePerson } from './session';

/**
 * A shared till: several people of one account on one device, each unlocking
 * it with their own PIN - so the till always knows who is selling, and each
 * person can do exactly what their role allows.
 *
 * The device stays signed in as whoever set it up. Colleagues are added once
 * with their password; the device keeps a grant for each, which together
 * with their PIN (and this device's session) unlocks the till as them. The
 * server holds the PINs and counts wrong guesses.
 *
 * Offline - a booth without signal - the till can still tell who is selling.
 * Someone who unlocked online once leaves a PIN check on the device, but only
 * if they do not outrank the device's own user: unlocked offline, they act
 * with the device's own access, so a leaked check never opens more than the
 * device already could. Their sales are still credited to them.
 */

export interface TillPerson {
  userId: string;
  email: string;
  role: Role;
  hasPin: boolean;
  /** Too many wrong PINs: no more tries until then. */
  lockedUntil: number | null;
  /** The device session's own user, who needs no grant. */
  isDevice: boolean;
}

export interface TillSettings {
  /** The till starts locked and can be locked; off, the device works as before. */
  enabled: boolean;
  /** Lock after this many idle minutes; 0 never. */
  idleMinutes: number;
  /** Lock shortly after each sale, for a till that changes hands all the time. */
  lockAfterSale: boolean;
  /** A scanned staff badge still asks for the PIN - for when a card could be lost or copied. */
  badgeNeedsPin: boolean;
}

const DEFAULTS: TillSettings = { enabled: false, idleMinutes: 5, lockAfterSale: false, badgeNeedsPin: false };
/** A badge scanned while the device asks for the PIN as well: the lock screen asks for it. */
export const pendingBadge = ref<string | null>(null);
const AFTER_SALE_MS = 15_000;

export const tillSettings = ref<TillSettings>({ ...DEFAULTS });
export const tillLocked = ref(false);
export const tillPeople = shallowRef<TillPerson[]>([]);

// ── Local storage: settings and grants, per account ─────────────────────────

const key = (what: string): string => `zollify.till.${what}.${getDeviceAccount()?.accountId ?? 'none'}`;
function read<T>(what: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key(what));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return Array.isArray(fallback) ? parsed : ({ ...fallback, ...parsed } as T);
  } catch {
    return fallback;
  }
}
function write(what: string, value: unknown): void {
  try {
    localStorage.setItem(key(what), JSON.stringify(value));
  } catch {
    // Private mode or storage full: the till still works for this session.
  }
}
const grants = (): Record<string, string> => read<Record<string, string>>('grants', {});
const setGrant = (userId: string, grant: string | null): void => {
  const next = { ...grants() };
  if (grant) next[userId] = grant;
  else delete next[userId];
  write('grants', next);
  if (!grant) forgetOffline(userId);
};

// ── Offline PIN checks ──────────────────────────────────────────────────────

interface OfflineCheck {
  salt: string;
  hash: string;
  snapshot: AccountSnapshot;
  misses: number;
}
const OFFLINE_MISSES = 5;
const offlineChecks = (): Record<string, OfflineCheck> => read<Record<string, OfflineCheck>>('offline', {});
function forgetOffline(userId: string): void {
  const next = { ...offlineChecks() };
  delete next[userId];
  write('offline', next);
  const badges = { ...offlineBadges() };
  delete badges[userId];
  write('badges', badges);
}
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function derive(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 210_000 }, key, 256));
}
/** After an online unlock: lets this person unlock offline next time, if that can never widen what the device may do. */
async function rememberOffline(snapshot: AccountSnapshot, pin: string): Promise<void> {
  const device = getDeviceAccount();
  if (!device || ROLE_RANK[snapshot.role] > ROLE_RANK[device.role]) return forgetOffline(snapshot.userId);
  try {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
    write('offline', { ...offlineChecks(), [snapshot.userId]: { salt, hash: await derive(pin, salt), snapshot, misses: 0 } });
  } catch {
    // No WebCrypto (an old WebView): offline unlocking just is not offered.
  }
}
/** True when the PIN matches the check left on this device; throws once too many wrong ones were tried. */
async function offlineUnlock(userId: string, pin: string): Promise<AccountSnapshot | null> {
  // Throws on a wrong PIN; null when this person never unlocked online here.
  const check = offlineChecks()[userId];
  if (!check) return null;
  if (check.misses >= OFFLINE_MISSES) throw new Error('Too many wrong PINs - unlocking needs a connection now.');
  if ((await derive(pin, check.salt)) !== check.hash) {
    write('offline', { ...offlineChecks(), [userId]: { ...check, misses: check.misses + 1 } });
    throw new Error('Wrong PIN.');
  }
  write('offline', { ...offlineChecks(), [userId]: { ...check, misses: 0 } });
  return check.snapshot;
}
const isOffline = (err: unknown): boolean => !(err as HttpError).status;

// Offline badge checks: a badge is a long random code, so a salted hash is
// enough (no slow derivation). Kept under the same rule as PIN checks.
interface OfflineBadge {
  salt: string;
  hash: string;
}
const offlineBadges = (): Record<string, OfflineBadge> => read<Record<string, OfflineBadge>>('badges', {});
const badgeKey = (code: string): string => code.trim().toUpperCase().replace(/-/g, '');
async function sha(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
async function rememberOfflineBadge(snapshot: AccountSnapshot, code: string): Promise<void> {
  const device = getDeviceAccount();
  const next = { ...offlineBadges() };
  delete next[snapshot.userId];
  if (device && ROLE_RANK[snapshot.role] <= ROLE_RANK[device.role]) {
    try {
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
      next[snapshot.userId] = { salt, hash: await sha(salt + badgeKey(code)) };
    } catch {
      // No WebCrypto: offline badges are not offered.
    }
  }
  write('badges', next);
}
async function offlineBadgeOwner(code: string): Promise<string | null> {
  for (const [userId, b] of Object.entries(offlineBadges())) if ((await sha(b.salt + badgeKey(code))) === b.hash) return userId;
  return null;
}

// ── People ──────────────────────────────────────────────────────────────────

/** The device's own user and everyone added to this device, as the server knows them. */
export async function refreshTillPeople(): Promise<TillPerson[]> {
  const device = getDeviceAccount();
  if (!device) return (tillPeople.value = []);
  const [{ people }, mine] = await Promise.all([
    deviceFetch(`/device-users?deviceId=${encodeURIComponent(await deviceId())}`) as Promise<{ people: Omit<TillPerson, 'isDevice'>[] }>,
    deviceFetch('/users/me/pin') as Promise<{ hasPin: boolean }>,
  ]);
  const held = grants();
  // Someone added on another browser profile has no grant here; they must be added again on this one.
  const others = people.filter((p) => held[p.userId]).map((p) => ({ ...p, isDevice: false }));
  for (const id of Object.keys(held)) if (!people.some((p) => p.userId === id)) setGrant(id, null);
  tillPeople.value = [{ userId: device.userId, email: device.email, role: device.role, hasPin: mine.hasPin, lockedUntil: null, isDevice: true }, ...others];
  // Kept for the lock screen of a till that opens without a connection.
  write('people', tillPeople.value);
  return tillPeople.value;
}

/** Adds a colleague to this device: their email and password once, and their PIN (new, or the one they have). */
export async function addTillPerson(input: { email: string; password: string; code?: string; pin?: string }): Promise<void> {
  const res = (await deviceFetch('/device-users', { method: 'POST', body: JSON.stringify({ ...input, deviceId: await deviceId() }) })) as { grant: string; person: { userId: string } };
  setGrant(res.person.userId, res.grant);
  await refreshTillPeople();
}

export async function removeTillPerson(userId: string): Promise<void> {
  await deviceFetch(`/device-users/${encodeURIComponent(userId)}?deviceId=${encodeURIComponent(await deviceId())}`, { method: 'DELETE' }).catch(() => undefined);
  setGrant(userId, null);
  dropPerson(userId);
  await refreshTillPeople();
}

/** Sets or clears the signed-in person's own PIN. */
export async function setOwnPin(password: string, pin: string | null): Promise<void> {
  await authFetch('/users/me/pin', { method: 'PUT', body: JSON.stringify({ password, pin }) });
  const me = getAccount();
  if (me) forgetOffline(me.userId);
  if (getDeviceAccount()) await refreshTillPeople().catch(() => undefined);
}

// ── Locking and unlocking ───────────────────────────────────────────────────

/**
 * Unlocks the till as a person. Throws the server's refusal (wrong PIN, too
 * many tries, removed from the device) for the PIN pad to show.
 */
export async function unlockTill(userId: string, pin: string): Promise<void> {
  const device = getDeviceAccount();
  if (!device) throw new Error('This device is signed out.');
  const id = await deviceId();
  if (userId === device.userId) {
    try {
      await deviceFetch('/auth/unlock', { method: 'POST', body: JSON.stringify({ deviceId: id, userId, pin }) });
      void rememberOffline(device, pin);
    } catch (err) {
      if (!isOffline(err) || !(await offlineUnlock(userId, pin))) throw err;
    }
    setActivePerson(null);
  } else {
    const grant = grants()[userId];
    if (!grant) throw Object.assign(new Error('Not on this device - add them again.'), { status: 404 });
    try {
      const res = (await deviceFetch('/auth/unlock', { method: 'POST', body: JSON.stringify({ deviceId: id, userId, pin, grant }) })) as { accessToken: string; user: TokenResponse['user'] };
      const session = personFrom(res, grant);
      setActivePerson(session);
      void rememberOffline(session.snapshot, pin);
    } catch (err) {
      if (isOffline(err)) {
        const known = await offlineUnlock(userId, pin);
        if (!known) throw new Error('No connection - this person has to unlock online once before it works offline.');
        activateOffline(known, grant);
      } else {
        if ((err as HttpError).body && ((err as HttpError).body as { removed?: boolean }).removed) {
          setGrant(userId, null);
          void refreshTillPeople().catch(() => undefined);
        }
        throw err;
      }
    }
  }
  unlocked();
}

/** Unlocked without a connection: acting with the device's access, so shown with no more than the device's role. */
function activateOffline(known: AccountSnapshot, grant: string): void {
  const device = getDeviceAccount()!;
  const role = ROLE_RANK[known.role] <= ROLE_RANK[device.role] ? known.role : device.role;
  setActivePerson({ snapshot: { ...known, role, accountName: device.accountName, profile: device.profile }, token: null, expiresAt: Number.MAX_SAFE_INTEGER, grant });
}

function unlocked(): void {
  tillLocked.value = false;
  pendingBadge.value = null;
  lastActivity = Date.now();
  deadline = 0;
}

/**
 * Unlocks the till with a scanned staff badge - and the PIN, when this device
 * asks for it after a badge. Throws the server's refusal for the lock screen.
 */
export async function unlockWithBadge(code: string, pin?: string): Promise<void> {
  const device = getDeviceAccount();
  if (!device) throw new Error('This device is signed out.');
  try {
    const res = (await deviceFetch('/auth/unlock-badge', {
      method: 'POST',
      body: JSON.stringify({ deviceId: await deviceId(), code: code.trim(), grants: grants(), ...(pin ? { pin } : {}) }),
    })) as { ok?: boolean; userId?: string; accessToken?: string; user?: TokenResponse['user'] };
    if (res.accessToken && res.user) {
      const session = personFrom({ accessToken: res.accessToken, user: res.user }, grants()[res.user.id] ?? '');
      setActivePerson(session);
      void rememberOfflineBadge(session.snapshot, code);
      if (pin) void rememberOffline(session.snapshot, pin);
    } else {
      setActivePerson(null);
      void rememberOfflineBadge(device, code);
      if (pin) void rememberOffline(device, pin);
    }
  } catch (err) {
    if (!isOffline(err)) {
      const body = ((err as HttpError).body ?? {}) as { removed?: boolean; userId?: string };
      if (body.removed && body.userId) {
        setGrant(body.userId, null);
        void refreshTillPeople().catch(() => undefined);
      }
      throw err;
    }
    const owner = await offlineBadgeOwner(code);
    if (!owner) throw new Error('No connection - this badge has to be used online once before it works offline.');
    if (pin && !(await offlineUnlock(owner, pin))) throw new Error('No connection - unlocking needs the PIN check from an earlier online unlock.');
    if (owner === device.userId) setActivePerson(null);
    else {
      const person = tillPeople.value.find((p) => p.userId === owner);
      const known: AccountSnapshot | null = offlineChecks()[owner]?.snapshot ?? (person ? { ...device, userId: person.userId, email: person.email, role: person.role } : null);
      const grant = grants()[owner];
      if (!known || !grant) throw new Error('Not on this device - add them again.');
      activateOffline(known, grant);
    }
  }
  unlocked();
}

/**
 * A badge scanned while the till is in use: hands it to the badge's owner.
 * The person handing over is locked out first, so their sales sync under
 * their own name.
 */
export async function switchByBadge(code: string): Promise<void> {
  if (!tillSettings.value.enabled) return;
  if (tillSettings.value.badgeNeedsPin) {
    await lockTill();
    pendingBadge.value = code;
    return;
  }
  const previous = getAccount();
  const device = getDeviceAccount();
  await syncNow().catch(() => undefined);
  await unlockWithBadge(code);
  if (previous && device && previous.userId !== device.userId && previous.userId !== getAccount()?.userId) {
    void deviceFetch('/auth/lock', { method: 'POST', body: JSON.stringify({ deviceId: await deviceId(), userId: previous.userId }) }).catch(() => undefined);
  }
}

// ── Badges ──────────────────────────────────────────────────────────────────

export interface StaffBadge {
  code: string | null;
  issuedAt: number | null;
  email: string;
}
export const loadBadge = (userId: string): Promise<StaffBadge> => authFetch(`/users/${encodeURIComponent(userId)}/badge`) as Promise<StaffBadge>;
export const issueBadge = (userId: string): Promise<StaffBadge> => authFetch(`/users/${encodeURIComponent(userId)}/badge`, { method: 'POST', body: '{}' }) as Promise<StaffBadge>;
export const revokeBadge = async (userId: string): Promise<void> => {
  await authFetch(`/users/${encodeURIComponent(userId)}/badge`, { method: 'DELETE' });
};

/**
 * Locks the till. Whatever the person did is pushed first, under their own
 * name; their session is kept a few minutes longer in case the push has to
 * wait for a connection.
 */
export async function lockTill(): Promise<void> {
  if (!tillSettings.value.enabled || tillLocked.value) return;
  const who = getAccount();
  const device = getDeviceAccount();
  tillLocked.value = true;
  await syncNow().catch(() => undefined);
  setActivePerson(null);
  if (who && device && who.userId !== device.userId) {
    void deviceFetch('/auth/lock', { method: 'POST', body: JSON.stringify({ deviceId: await deviceId(), userId: who.userId }) }).catch(() => undefined);
  }
}

export function saveTillSettings(next: TillSettings): void {
  tillSettings.value = { ...next };
  write('settings', tillSettings.value);
  if (!next.enabled) {
    tillLocked.value = false;
    setActivePerson(null);
  }
}

// ── Idle locking ────────────────────────────────────────────────────────────

let lastActivity = Date.now();
/** A one-off lock time, set after a sale when the till locks after each one. */
let deadline = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const touch = (): void => {
  lastActivity = Date.now();
  if (deadline) deadline = Math.max(deadline, lastActivity + AFTER_SALE_MS);
};

/** Called by the shell after each sale. */
export function noteSale(): void {
  if (tillSettings.value.enabled && tillSettings.value.lockAfterSale) deadline = Date.now() + AFTER_SALE_MS;
}

/**
 * Reads this device's till settings at start, and starts locked when the
 * till is shared - the person who opens it says who they are.
 */
export function startTillLock(opts: { unlocked?: boolean } = {}): void {
  tillSettings.value = read('settings', { ...DEFAULTS });
  // Just signed in with a password: that already says who is here.
  tillLocked.value = tillSettings.value.enabled && !opts.unlocked;
  lastActivity = Date.now();
  tillPeople.value = read<TillPerson[]>('people', []);
  if (tillSettings.value.enabled) void refreshTillPeople().catch(() => undefined);
  onPersonSessionLost((_userId, wasActive) => {
    // Their unlock ran out or they were taken off the device: whoever is at the till must say who they are again.
    if (wasActive) {
      tillLocked.value = false;
      void lockTill();
    }
    void refreshTillPeople().catch(() => undefined);
  });
  if (timer) return;
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(ev, touch, { passive: true });
  timer = setInterval(() => {
    const s = tillSettings.value;
    if (!s.enabled || tillLocked.value) return;
    const now = Date.now();
    if ((deadline && now >= deadline) || (s.idleMinutes > 0 && now - lastActivity >= s.idleMinutes * 60_000)) {
      deadline = 0;
      void lockTill();
    }
  }, 5_000);
}
