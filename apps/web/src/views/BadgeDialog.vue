<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { currentAccount, issueBadge, loadBadge, revokeBadge, shellConfirm, type StaffBadge } from '@zollify/platform';
import { ModalShell } from '@zollify/ui';
import BadgeCard from './BadgeCard.vue';

/**
 * Someone's staff badge: show and print it, make a new one (the old card
 * stops working), or turn badges off for them.
 */
const props = defineProps<{ userId: string; email: string }>();
const emit = defineEmits<{ close: [] }>();

const badge = ref<StaffBadge | null>(null);
const error = ref<string | null>(null);
const name = props.email.split('@')[0]!.replace(/[._-]+/g, ' ');
const accountName = currentAccount.value?.accountName ?? '';

async function run(fn: () => Promise<void>): Promise<void> {
  error.value = null;
  try {
    await fn();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'That did not work.';
  }
}
onMounted(() => run(async () => void (badge.value = await loadBadge(props.userId))));

async function renew(): Promise<void> {
  if (badge.value?.code && !(await shellConfirm('The current card stops working at once. Print the new one before handing it out.', 'Make a new badge?'))) return;
  await run(async () => void (badge.value = await issueBadge(props.userId)));
}
async function revoke(): Promise<void> {
  if (!(await shellConfirm(`${props.email} can no longer unlock tills with a badge; their PIN still works.`, 'Turn off the badge?'))) return;
  await run(async () => {
    await revokeBadge(props.userId);
    badge.value = { code: null, issuedAt: null, email: props.email };
  });
}
</script>

<template>
  <ModalShell :title="`Badge for ${email}`" @close="emit('close')">
    <div class="body">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="!badge" class="hint">Loading…</p>
      <template v-else-if="badge.code">
        <BadgeCard :code="badge.code" :name="name" :account-name="accountName" />
        <p class="hint">Scanning it unlocks the shared tills {{ email }} was added to. Made {{ badge.issuedAt ? new Date(badge.issuedAt).toLocaleDateString() : '' }}. Lost it? Make a new one - this one then stops working.</p>
      </template>
      <p v-else class="hint">No badge yet. A badge is a card with a barcode: scanning it at a shared till unlocks it as {{ email }}, on tills they were added to.</p>
    </div>
    <template #footer>
      <div class="footer">
        <button v-if="badge?.code" type="button" class="quiet" @click="revoke">Turn off</button>
        <span class="grow" />
        <button type="button" @click="renew">{{ badge?.code ? 'New badge' : 'Make a badge' }}</button>
        <button type="button" class="primary" @click="emit('close')">Done</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.body { display: flex; flex-direction: column; gap: .8rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.footer { display: flex; gap: .5rem; align-items: center; width: 100%; }
.grow { flex: 1; }
</style>
