<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { authFetch, currentAccount, updateProfile, visibleEvents } from '@zollify/platform';
import BadgeDialog from './BadgeDialog.vue';

/**
 * Team management.
 *
 * The auth layer has supported helpers since day one - a `member` scoped to
 * specific events - but nothing exposed it, so the capability existed with no
 * way to use it. This is that screen.
 */

interface TeamUser {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  allowedEventIds: string[] | null;
  createdAt: number;
  lastLoginAt: number | null;
}

interface Invite {
  code: string;
  role: string;
  allowedEventIds: string[] | null;
  createdAt: number;
  expiresAt: number;
  usedBy?: string | null;
}

const account = currentAccount;
const users = ref<TeamUser[]>([]);
const invites = ref<Invite[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
const newCode = ref<string | null>(null);

const inviteRole = ref<'member' | 'admin'>('member');
const inviteEvents = ref<Set<string>>(new Set());

const isOwner = computed(() => account.value?.role === 'owner');

async function refresh(): Promise<void> {
  try {
    const [u, i] = await Promise.all([
      authFetch('/users') as Promise<{ users: TeamUser[] }>,
      authFetch('/invites') as Promise<{ invites: Invite[] }>,
    ]);
    users.value = u.users;
    invites.value = i.invites;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the team.';
  }
}

onMounted(refresh);

function toggleEvent(id: string): void {
  const next = new Set(inviteEvents.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  inviteEvents.value = next;
}

async function createInvite(): Promise<void> {
  busy.value = true;
  error.value = null;
  newCode.value = null;
  try {
    // An invite carrying events makes the holder a helper; the server forces
    // the role to `member` in that case regardless of what is asked for.
    const res = (await authFetch('/invites', {
      method: 'POST',
      body: JSON.stringify({
        role: inviteRole.value,
        allowedEventIds: inviteRole.value === 'member' ? [...inviteEvents.value] : [],
      }),
    })) as { code: string; expiresInDays: number };

    newCode.value = res.code;
    inviteEvents.value = new Set();
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create an invite.';
  } finally {
    busy.value = false;
  }
}

async function setScope(user: TeamUser, eventIds: string[]): Promise<void> {
  error.value = null;
  try {
    await authFetch(`/users/${user.id}/events`, {
      method: 'PUT',
      body: JSON.stringify({ allowedEventIds: eventIds }),
    });
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Could not change that member's events.";
  }
}

function scopeLabel(user: TeamUser): string {
  if (user.role !== 'member') return 'Full access';
  if (!user.allowedEventIds?.length) return 'Staff · sells, counts own cash';
  const names = user.allowedEventIds.map(
    (id) => visibleEvents.value.find((e) => e.id === id)?.name ?? 'removed event',
  );
  return `Helper · ${names.join(', ')}`;
}

function when(ts: number | null): string {
  return ts ? new Date(ts).toLocaleDateString() : 'never';
}

// Staff badges: an admin prints them for anyone who does not outrank them.
const badgeFor = ref<TeamUser | null>(null);
const canBadge = (u: TeamUser): boolean => u.role !== 'owner' || currentAccount.value?.role === 'owner';

// Whether staff see sales totals - takings, stats, what the cash box should hold.
const staffTotals = computed(() => currentAccount.value?.profile.staffSeesTotals === true);
const savingTotals = ref(false);
async function setStaffTotals(on: boolean): Promise<void> {
  savingTotals.value = true;
  error.value = null;
  try {
    await updateProfile({ staffSeesTotals: on });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that.';
  } finally {
    savingTotals.value = false;
  }
}
</script>

<template>
  <section class="team">
    <h2>Team</h2>
    <p class="hint">
      Invite someone by sending them a code. <strong>Staff</strong> sell at the till and cash up
      their own drawer - each sale records who made it - but cannot change products, prices,
      discounts, events or settings. Staff limited to specific events are <strong>helpers</strong>:
      they only see and sync those events. <strong>Admins</strong> run the store with you.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <BadgeDialog v-if="badgeFor" :user-id="badgeFor.id" :email="badgeFor.email" @close="badgeFor = null" />

    <label class="totals-toggle">
      <input type="checkbox" :checked="staffTotals" :disabled="savingTotals" @change="setStaffTotals(($event.target as HTMLInputElement).checked)" />
      <span>
        <strong>Staff can see sales totals</strong>
        <small>Takings on Home and the till, History's figures and exports, event totals, and the expected cash in Cash up. Off, staff see only their own sales one by one and cash up blind: they count the box, you compare.</small>
      </span>
    </label>

    <h3>People</h3>
    <ul class="list">
      <li v-for="user in users" :key="user.id">
        <div class="meta">
          <strong>{{ user.email }}</strong>
          <span>{{ user.role }} · {{ scopeLabel(user) }} · last seen {{ when(user.lastLoginAt) }}</span>
        </div>
        <button v-if="canBadge(user)" type="button" @click="badgeFor = user">Badge</button>
        <button
          v-if="user.role === 'member' && user.allowedEventIds?.length"
          type="button"
          @click="setScope(user, [])"
        >
          Give full access
        </button>
      </li>
    </ul>

    <h3>Invite someone</h3>
    <form class="invite" @submit.prevent="createInvite">
      <label>
        <span>Role</span>
        <select v-model="inviteRole">
          <option value="member">Staff</option>
          <option v-if="isOwner" value="admin">Admin</option>
        </select>
      </label>

      <fieldset v-if="inviteRole === 'member'">
        <legend>Limit to events (optional)</legend>
        <p class="hint">Leave all unticked for staff who work every store and event.</p>
        <label v-for="event in visibleEvents" :key="event.id" class="inline">
          <input
            type="checkbox"
            :checked="inviteEvents.has(event.id)"
            @change="toggleEvent(event.id)"
          />
          <span>{{ event.name }}</span>
        </label>
        <p v-if="!visibleEvents.length" class="hint">No events yet.</p>
      </fieldset>

      <button type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Create invite code' }}</button>
    </form>

    <p v-if="newCode" class="code" role="status">
      Invite code: <strong>{{ newCode }}</strong> - valid for 14 days.
    </p>

    <template v-if="invites.length">
      <h3>Outstanding invites</h3>
      <ul class="list muted">
        <li v-for="invite in invites" :key="invite.code">
          <div class="meta">
            <strong>{{ invite.code }}</strong>
            <span>
              {{ invite.role }}
              <template v-if="invite.allowedEventIds?.length">
                · helper, {{ invite.allowedEventIds.length }} event(s)
              </template>
              · {{ invite.usedBy ? 'used' : `expires ${when(invite.expiresAt)}` }}
            </span>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.totals-toggle { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem .75rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); cursor: pointer; }
.totals-toggle input { margin-top: .2rem; }
.totals-toggle span { display: flex; flex-direction: column; gap: .15rem; font-size: .875rem; }
.totals-toggle small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.team { display: flex; flex-direction: column; gap: .75rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .75rem 0 0; font-size: .95rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.code { margin: 0; font-size: .9rem; color: var(--zfy-accent-ink, #0a5a4a); }
.code strong { font-family: ui-monospace, monospace; letter-spacing: .08em; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; background: var(--zfy-surface, #fff); }
.list.muted li { opacity: .8; }
.meta { display: flex; flex-direction: column; gap: .1rem; font-size: .9rem; }
.meta span { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
.invite { display: flex; flex-direction: column; gap: .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); align-items: flex-start; }
.invite label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.invite label.inline { flex-direction: row; align-items: center; gap: .4rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .3rem; width: 100%; }
legend { font-size: .8rem; padding: 0 .3rem; color: var(--zfy-muted, #5a6472); }
</style>
