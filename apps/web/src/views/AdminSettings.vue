<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AdminAccount, AdminAccountDetail, AdminLogEntry, AdminMetricRow, AdminOverview } from '@zollify/shared';
import { authFetch, shellConfirm } from '@zollify/platform';
import { Icon } from '@zollify/ui';

/**
 * Server admin — ported from ZollTool. Owner only: usage overview, activity
 * over the last 30 days, new-account invites, every account with its users
 * and devices, uploaded diagnostic logs, and every login session on the
 * server with remote sign-out.
 */

const loading = ref(true);
const error = ref<string | null>(null);
const overview = ref<AdminOverview | null>(null);
const accounts = ref<AdminAccount[]>([]);
const metrics = ref<AdminMetricRow[]>([]);
const logs = ref<AdminLogEntry[]>([]);
interface AdminSession {
  id: string;
  userId: string;
  email: string;
  role: string;
  accountName: string;
  deviceId: string | null;
  deviceName: string | null;
  device: string | null;
  ip: string | null;
  geo: string | null;
  flavor: string | null;
  createdAt: number;
  lastUsedAt: number;
}
const sessions = ref<AdminSession[]>([]);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [o, a, m, l, s] = await Promise.all([
      authFetch('/admin/overview') as Promise<AdminOverview>,
      authFetch('/admin/accounts') as Promise<AdminAccount[]>,
      authFetch('/admin/metrics?days=30') as Promise<AdminMetricRow[]>,
      authFetch('/admin/logs') as Promise<AdminLogEntry[]>,
      authFetch('/admin/sessions') as Promise<{ sessions: AdminSession[] }>,
    ]);
    overview.value = o;
    accounts.value = a;
    metrics.value = m;
    logs.value = l;
    sessions.value = s.sessions;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the admin data.';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const tiles = computed<[string, string | number][]>(() =>
  overview.value ? [['Accounts', overview.value.accounts], ['Users', overview.value.users], ['Devices', overview.value.devices], ['Ops stored', overview.value.ops.toLocaleString()], ['Sales', overview.value.transactions.toLocaleString()], ['Active today', overview.value.activeToday]] : [],
);

/** Server-wide totals per day for the activity bars. */
const daily = computed(() => {
  const byDay = new Map<string, { ops: number; tx: number; logins: number }>();
  for (const m of metrics.value) {
    const cur = byDay.get(m.day) ?? { ops: 0, tx: 0, logins: 0 };
    cur.ops += m.opsReceived;
    cur.tx += m.txCount;
    cur.logins += m.logins;
    byDay.set(m.day, cur);
  }
  const rows = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, ...v }));
  const max = Math.max(1, ...rows.map((r) => r.ops));
  return rows.map((r) => ({ ...r, pct: Math.round((r.ops / max) * 100) }));
});

// ── Invites ─────────────────────────────────────────────────────────────────
const inviteCode = ref('');
const inviteBusy = ref(false);
async function invite(newAccount: boolean): Promise<void> {
  inviteBusy.value = true;
  error.value = null;
  try {
    const res = (await authFetch('/invites', { method: 'POST', body: JSON.stringify({ newAccount, role: 'admin' }) })) as { code: string };
    inviteCode.value = res.code;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create an invite.';
  } finally {
    inviteBusy.value = false;
  }
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked — the code is on screen */
  }
}

// ── Accounts ────────────────────────────────────────────────────────────────
const openAccount = ref<string | null>(null);
const detail = ref<AdminAccountDetail | null>(null);
async function toggleAccount(id: string): Promise<void> {
  if (openAccount.value === id) {
    openAccount.value = null;
    return;
  }
  openAccount.value = id;
  detail.value = null;
  try {
    detail.value = (await authFetch(`/admin/accounts/${id}`)) as AdminAccountDetail;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load that account.';
  }
}

// ── Logs ────────────────────────────────────────────────────────────────────
const openLog = ref<string | null>(null);
const logText = ref('');
async function viewLog(entry: AdminLogEntry): Promise<void> {
  if (openLog.value === entry.id) {
    openLog.value = null;
    return;
  }
  openLog.value = entry.id;
  logText.value = 'Loading…';
  try {
    logText.value = ((await authFetch(`/admin/logs/${entry.id}`)) as { text: string }).text || '(empty)';
  } catch (err) {
    logText.value = err instanceof Error ? err.message : 'Could not load the log.';
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────
async function revoke(s: AdminSession): Promise<void> {
  if (!(await shellConfirm(`${s.email} on ${s.deviceName || s.device || 'that device'} must sign in again.`, 'Log out this session?'))) return;
  await authFetch(`/admin/sessions/${s.id}`, { method: 'DELETE' });
  sessions.value = sessions.value.filter((x) => x.id !== s.id);
}

const when = (ts: number | null): string => (ts ? new Date(ts).toLocaleString() : 'never');
const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;
</script>

<template>
  <section class="admin">
    <div class="head">
      <h2>Server admin</h2>
      <button type="button" class="quiet" :disabled="loading" @click="load"><Icon name="refresh-cw" :size="14" /> Refresh</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading && !overview" class="hint">Loading…</p>

    <template v-if="overview">
      <div class="tiles">
        <div v-for="[label, value] in tiles" :key="label" class="tile"><span>{{ label }}</span><strong>{{ value }}</strong></div>
      </div>

      <article class="card">
        <h3>Activity — last 30 days</h3>
        <p v-if="!daily.length" class="hint">No activity recorded yet.</p>
        <div v-else class="days">
          <div v-for="d in daily" :key="d.day" class="dayrow">
            <span class="muted">{{ d.day.slice(5) }}</span>
            <div class="bar"><div :style="{ width: d.pct + '%' }"></div></div>
            <small class="muted">{{ d.ops }} ops · {{ d.tx }} sales · {{ d.logins }} logins</small>
          </div>
        </div>
      </article>

      <article class="card">
        <h3>Invites</h3>
        <div class="row">
          <button type="button" :disabled="inviteBusy" @click="invite(false)">Invite admin to my account</button>
          <button type="button" :disabled="inviteBusy" @click="invite(true)">New-account invite</button>
          <button v-if="inviteCode" type="button" class="quiet code" title="Copy" @click="copy(inviteCode)"><code>{{ inviteCode }}</code> <Icon name="copy" :size="14" /></button>
        </div>
        <p class="hint">Codes are single-use and valid for 14 days. Members and helpers are invited under Settings → Team.</p>
      </article>

      <article class="card">
        <h3>Accounts</h3>
        <ul class="list">
          <li v-for="a in accounts" :key="a.id">
            <button type="button" class="row-btn" @click="toggleAccount(a.id)">
              <span class="main"><span>{{ a.name }}</span><small>{{ a.userCount }} users · {{ a.deviceCount }} devices · {{ a.opCount.toLocaleString() }} ops · {{ a.txTotal.toLocaleString() }} sales · active {{ when(a.lastActivityAt) }}</small></span>
              <Icon :name="openAccount === a.id ? 'chevron-down' : 'chevron-right'" :size="14" />
            </button>
            <div v-if="openAccount === a.id" class="detail">
              <p v-if="!detail" class="hint">Loading…</p>
              <template v-else>
                <p class="sub">Users</p>
                <ul class="plain"><li v-for="u in detail.users" :key="u.id">{{ u.email }} <em>{{ u.role }}</em><small>last login {{ when(u.lastLoginAt) }}</small></li></ul>
                <p class="sub">Devices</p>
                <ul class="plain"><li v-for="d in detail.devices" :key="d.id">{{ d.name || 'Unnamed' }}<small>seen {{ when(d.lastSeenAt) }}</small></li></ul>
              </template>
            </div>
          </li>
        </ul>
      </article>

      <article class="card">
        <h3>Diagnostic logs</h3>
        <p v-if="!logs.length" class="hint">Nothing uploaded yet. A device sends its log from This device, or from a failed card payment.</p>
        <ul v-else class="list">
          <li v-for="l in logs" :key="l.id">
            <button type="button" class="row-btn" @click="viewLog(l)">
              <span class="main"><span>{{ l.accountName }} · {{ l.deviceName || l.deviceId.slice(0, 8) }}<em v-if="l.reason">{{ l.reason }}</em></span><small>{{ when(l.createdAt) }} · {{ l.flavor || 'web' }}<template v-if="l.appVersion"> {{ l.appVersion }}</template> · {{ kb(l.size) }}</small></span>
              <Icon :name="openLog === l.id ? 'chevron-down' : 'chevron-right'" :size="14" />
            </button>
            <pre v-if="openLog === l.id" class="log">{{ logText }}</pre>
          </li>
        </ul>
      </article>

      <article class="card">
        <h3>Login sessions</h3>
        <p class="hint">Every signed-in device on this server. Logging one out forces a fresh sign-in there.</p>
        <ul class="list">
          <li v-for="s in sessions" :key="s.id" class="session">
            <span class="main"><span>{{ s.email }} <em>{{ s.role }}</em> · {{ s.accountName }}</span><small>{{ [s.deviceName || s.device, s.ip, s.geo, s.flavor].filter(Boolean).join(' · ') }} · active {{ when(s.lastUsedAt) }}</small></span>
            <button type="button" class="quiet danger" @click="revoke(s)">Log out</button>
          </li>
        </ul>
      </article>
    </template>
  </section>
</template>

<style scoped>
.admin { display: flex; flex-direction: column; gap: .8rem; max-width: 52rem; }
.head { display: flex; align-items: center; gap: .6rem; }
.head h2 { flex: 1; margin: 0; font-size: 1.05rem; }
.head .quiet { display: inline-flex; align-items: center; gap: .3rem; }
h3 { margin: 0; font-size: .95rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.muted { color: var(--zfy-muted, #5a6472); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .5rem; }
.tile { display: flex; flex-direction: column; gap: .1rem; padding: .6rem .8rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.tile span { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.tile strong { font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; display: flex; flex-direction: column; gap: .6rem; }
.days { display: flex; flex-direction: column; gap: .3rem; font-size: .78rem; }
.dayrow { display: grid; grid-template-columns: 3rem 1fr 14rem; gap: .5rem; align-items: center; }
.bar { height: .9rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); overflow: hidden; }
.bar div { height: 100%; border-radius: 4px; background: var(--zfy-accent, #0e7c66); opacity: .75; }
.row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.code { display: inline-flex; align-items: center; gap: .3rem; }
.code code { font-family: ui-monospace, monospace; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.row-btn { width: 100%; display: flex; align-items: center; gap: .5rem; padding: .45rem .6rem; border: 0; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); text-align: left; font-weight: 400; }
.session { display: flex; align-items: center; gap: .5rem; padding: .45rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: .875rem; }
.main small, .plain small { color: var(--zfy-muted, #5a6472); font-size: .74rem; margin-left: .3rem; }
em { font-style: normal; font-weight: 500; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-surface, #fff); color: var(--zfy-muted, #5a6472); vertical-align: middle; }
.detail { padding: .4rem .8rem .2rem; display: flex; flex-direction: column; gap: .2rem; }
.sub { margin: .3rem 0 0; font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.plain { list-style: none; margin: 0; padding: 0; font-size: .85rem; display: flex; flex-direction: column; gap: .15rem; }
.log { margin: .3rem 0 0; max-height: 20rem; overflow: auto; padding: .6rem .8rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .72rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.session .quiet { min-height: 1.8rem; font-size: .78rem; }
</style>
