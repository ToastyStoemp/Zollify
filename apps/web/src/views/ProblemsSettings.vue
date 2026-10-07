<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { authFetch, currentAccount } from '@zollify/platform';
import { refreshProblemCount } from '../lib/problems';

/**
 * Settings → Problems: what quietly failed - a webhook that stopped, email
 * that did not go out, a scheduled job, a backup. Owners and admins see the
 * open ones, with how often and when last, and dismiss what is dealt with. A
 * source that works again closes its own problem.
 */

interface Problem {
  id: string;
  kind: string;
  severity: 'warning' | 'error';
  message: string;
  detail: string;
  link: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
}

const problems = ref<Problem[] | null>(null);
const emailDigest = ref(true);
const error = ref<string | null>(null);
const isOwner = computed(() => currentAccount.value?.role === 'owner');

async function refresh(): Promise<void> {
  try {
    const res = (await authFetch('/problems')) as { problems: Problem[]; emailDigest: boolean };
    problems.value = res.problems;
    emailDigest.value = res.emailDigest;
    error.value = null;
    void refreshProblemCount();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load problems.';
  }
}
onMounted(refresh);

const open = computed(() => (problems.value ?? []).filter((p) => p.resolvedAt == null));
const closed = computed(() => (problems.value ?? []).filter((p) => p.resolvedAt != null).slice(0, 10));

async function dismiss(p: Problem): Promise<void> {
  await authFetch(`/problems/${p.id}/dismiss`, { method: 'POST', body: '{}' }).catch((err) => (error.value = err instanceof Error ? err.message : 'Could not dismiss it.'));
  await refresh();
}

async function setDigest(): Promise<void> {
  const wanted = emailDigest.value;
  try {
    await authFetch('/problems/settings', { method: 'PUT', body: JSON.stringify({ emailDigest: wanted }) });
  } catch (err) {
    emailDigest.value = !wanted;
    error.value = err instanceof Error ? err.message : 'Could not save that.';
  }
}

const when = (ms: number): string => new Date(ms).toLocaleString();
</script>

<template>
  <section class="problems">
    <h2>Problems</h2>
    <p class="hint">Things that failed without anyone being asked: a webhook that stopped, an email that did not go out, a report that could not close, a backup. They close by themselves when the source works again.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <p v-if="problems && !open.length" class="empty">Nothing needs attention.</p>
    <ul v-else-if="problems" class="list">
      <li v-for="p in open" :key="p.id" :class="p.severity">
        <div class="meta">
          <strong><span class="tag" :class="p.severity">{{ p.severity === 'error' ? 'Error' : 'Warning' }}</span> {{ p.message }}</strong>
          <small v-if="p.detail">{{ p.detail }}</small>
          <small>{{ p.count }} {{ p.count === 1 ? 'time' : 'times' }} · last {{ when(p.lastSeen) }} · since {{ when(p.firstSeen) }}</small>
        </div>
        <div class="actions">
          <router-link v-if="p.link" :to="p.link" class="button">Open settings</router-link>
          <button type="button" class="quiet" @click="dismiss(p)">Dismiss</button>
        </div>
      </li>
    </ul>

    <details v-if="closed.length" class="closed">
      <summary>Recently closed</summary>
      <ul class="list">
        <li v-for="p in closed" :key="p.id" class="done">
          <div class="meta">
            <strong>{{ p.message }}</strong>
            <small>{{ p.dismissedAt ? 'Dismissed' : 'Resolved' }} {{ when(p.resolvedAt!) }}</small>
          </div>
        </li>
      </ul>
    </details>

    <label v-if="isOwner" class="check">
      <input v-model="emailDigest" type="checkbox" @change="setDigest" />
      <span><strong>Email me new errors</strong><small>One email a day at most, listing errors that opened since the last one. Needs the server to be set up for email.</small></span>
    </label>
  </section>
</template>

<style scoped>
.problems { display: flex; flex-direction: column; gap: .75rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.empty { margin: 0; padding: 1.2rem; text-align: center; color: var(--zfy-muted, #5a6472); border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.list li { display: flex; gap: .7rem; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; padding: .7rem .85rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.list li.error { border-color: var(--zfy-danger, #c6512f); }
.list li.done { opacity: .7; }
.meta { display: flex; flex-direction: column; gap: .15rem; min-width: 0; flex: 1 1 18rem; font-size: .86rem; }
.meta small { font-size: .75rem; color: var(--zfy-muted, #5a6472); overflow-wrap: anywhere; }
.tag { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; padding: .05rem .4rem; border-radius: 999px; border: 1px solid var(--zfy-warning, #c08a2e); color: var(--zfy-warning, #c08a2e); }
.tag.error { border-color: var(--zfy-danger, #c6512f); color: var(--zfy-danger, #c6512f); }
.actions { display: flex; gap: .4rem; align-items: center; }
.actions button, .actions .button { min-height: 2.1rem; font-size: .8rem; }
.closed summary { cursor: pointer; font-size: .82rem; color: var(--zfy-muted, #5a6472); margin-bottom: .5rem; }
.check { display: flex; align-items: flex-start; gap: .5rem; font-size: .875rem; }
.check span { display: flex; flex-direction: column; }
.check small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
</style>
