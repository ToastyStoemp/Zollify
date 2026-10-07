<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { Consignor } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import { consignors, deleteConsignor, errorText, issueLinkCode, productsOf, publicUrl, saveConsignor, stores, unlinkConsignor } from '../api';
import { sdk } from '../runtime';

/**
 * The artists this account sells for. Each one names the stores that carry
 * them - one for an artist unique to a shop, several for one shared between
 * them - and a commission, optionally different per store.
 */
const emit = defineEmits<{ error: [message: string | null]; items: [consignorId: string] }>();

const showArchived = ref(false);
const list = computed(() =>
  consignors.value.filter((c) => showArchived.value || !c.archived).sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name)),
);
const storeName = (id: string): string => stores.value.find((s) => s.id === id)?.name ?? 'Removed store';
const fmtPct = (n: number): string => `${Number(n.toFixed(2))}%`;

function storesLine(c: Consignor): string {
  if (!c.storeIds.length) return 'No store yet';
  return c.storeIds.map((id) => `${storeName(id)}${c.storeCommission[id] != null ? ` (${fmtPct(c.storeCommission[id]!)})` : ''}`).join(', ');
}

// ── Editor ──────────────────────────────────────────────────────────────────
const editing = ref(false);
const editId = ref<string | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const form = reactive({
  name: '',
  email: '',
  commissionPct: '40',
  storeIds: [] as string[],
  /** Per-store commission, blank = the default above. */
  storeCommission: {} as Record<string, string>,
  note: '',
  iban: '',
  bic: '',
  archived: false,
});

function openNew(): void {
  editId.value = null;
  Object.assign(form, {
    name: '',
    email: '',
    commissionPct: '40',
    // With a single store there is nothing to choose.
    storeIds: stores.value.length === 1 ? [stores.value[0]!.id] : [],
    storeCommission: {},
    note: '',
    iban: '',
    bic: '',
    archived: false,
  });
  formError.value = null;
  editing.value = true;
}
function openEdit(c: Consignor): void {
  editId.value = c.id;
  Object.assign(form, {
    name: c.name,
    email: c.email,
    commissionPct: String(c.commissionPct),
    storeIds: [...c.storeIds],
    storeCommission: Object.fromEntries(Object.entries(c.storeCommission).map(([k, v]) => [k, String(v)])),
    note: c.note,
    iban: c.iban,
    bic: c.bic,
    archived: c.archived,
  });
  formError.value = null;
  editing.value = true;
}

const pct = (v: string): number | null => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

async function save(): Promise<void> {
  const commissionPct = pct(form.commissionPct);
  if (!form.name.trim()) return void (formError.value = 'Give the artist a name.');
  if (commissionPct == null) return void (formError.value = 'Commission is a percentage between 0 and 100.');
  const storeCommission: Record<string, number> = {};
  for (const id of form.storeIds) {
    const raw = form.storeCommission[id]?.trim();
    if (!raw) continue;
    const v = pct(raw);
    if (v == null) return void (formError.value = `The commission for ${storeName(id)} is a percentage between 0 and 100.`);
    storeCommission[id] = v;
  }
  saving.value = true;
  try {
    await saveConsignor(editId.value ?? crypto.randomUUID(), {
      name: form.name.trim(),
      email: form.email.trim(),
      commissionPct,
      storeCommission,
      storeIds: [...form.storeIds],
      note: form.note.trim(),
      iban: form.iban,
      bic: form.bic,
      archived: form.archived,
    });
    editing.value = false;
  } catch (err) {
    formError.value = errorText(err, 'Could not save the artist.');
  } finally {
    saving.value = false;
  }
}

async function remove(c: Consignor): Promise<void> {
  const items = productsOf(c.id).length;
  const ok = await sdk().ui.confirm(
    `${c.name} is removed.${items ? ` Their ${items} item${items === 1 ? '' : 's'} stay in the catalogue as your own stock.` : ''} An artist with sales or payouts can only be archived.`,
    'Remove artist?',
  );
  if (!ok) return;
  try {
    await deleteConsignor(c.id);
    editing.value = false;
  } catch (err) {
    formError.value = errorText(err, 'Could not remove the artist.');
  }
}

// ── Linking the artist's own account ──────────────────────────────────────
const code = ref<{ name: string; code: string; expiresAt: number } | null>(null);
async function link(c: Consignor): Promise<void> {
  emit('error', null);
  try {
    const res = await issueLinkCode(c.id);
    code.value = { name: c.name, ...res };
  } catch (err) {
    emit('error', errorText(err, 'Could not create an invite.'));
  }
}
/** Opens Create account with the code filled in; someone with an account enters the code instead. */
const signUpLink = (raw: string): string => publicUrl(`/#/login?invite=${encodeURIComponent(raw.replace(/-/g, ''))}`);
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    sdk().ui.toast('Copied.', { kind: 'success' });
  } catch {
    /* the text is on screen to copy by hand */
  }
}
async function unlink(c: Consignor): Promise<void> {
  const ok = await sdk().ui.confirm(`${c.linkedAccountName} stops seeing their sales and payouts here, and you can no longer import from their catalogue. Their items and history stay.`, 'Unlink account?');
  if (!ok) return;
  try {
    await unlinkConsignor(c.id);
  } catch (err) {
    emit('error', errorText(err, 'Could not unlink the account.'));
  }
}
const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString();
</script>

<template>
  <div class="tab">
    <div class="bar">
      <p class="hint">Artists whose work you sell. Their items sell through the till like your own; the statement works out what each is owed.</p>
      <label class="check"><input v-model="showArchived" type="checkbox" /> Show archived</label>
      <button type="button" class="primary" @click="openNew"><Icon name="plus" :size="16" /> New artist</button>
    </div>

    <p v-if="!stores.length" class="warn">
      You have no stores yet. Add one under Stores → New store, then assign artists to it. Artists can also be sold at events without a store.
    </p>
    <p v-if="!list.length" class="empty">No artists yet.</p>

    <ul v-else class="grid">
      <li v-for="c in list" :key="c.id" :class="['card', { archived: c.archived }]">
        <div class="title">
          <strong>{{ c.name }}</strong>
          <span v-if="c.archived" class="pill">archived</span>
          <span v-else-if="c.linked" class="pill linked" :title="`Linked to the Zollify account ${c.linkedAccountName}`">linked</span>
          <span v-else-if="c.linkPending" class="pill">invited</span>
        </div>
        <p class="meta">{{ fmtPct(c.commissionPct) }} commission · {{ productsOf(c.id).length }} item{{ productsOf(c.id).length === 1 ? '' : 's' }}</p>
        <p class="meta"><Icon name="store" :size="13" /> {{ storesLine(c) }}</p>
        <p v-if="c.linked" class="meta">Account: {{ c.linkedAccountName }}</p>
        <div class="actions">
          <button type="button" @click="emit('items', c.id)"><Icon name="tag" :size="14" /> Items</button>
          <button type="button" @click="openEdit(c)">Edit</button>
          <button v-if="!c.linked" type="button" @click="link(c)"><Icon name="send" :size="14" /> {{ c.linkPending ? 'New invite' : 'Invite' }}</button>
          <button v-else type="button" class="quiet" @click="unlink(c)">Unlink</button>
        </div>
      </li>
    </ul>

    <ModalShell v-if="code" :title="`Invite ${code.name}`" @close="code = null">
      <div class="form">
        <p><strong>New to Zollify?</strong> Send them this link. It creates their account with “My stores” switched on, where they accept or decline your invite.</p>
        <div class="copy-row"><input :value="signUpLink(code.code)" type="text" readonly aria-label="Sign-up link" @focus="($event.target as HTMLInputElement).select()" /><button type="button" @click="copy(signUpLink(code.code))">Copy</button></div>
        <p><strong>Already on Zollify?</strong> They enter this code under <strong>Stores → My stores</strong> in the account they use for their events.</p>
        <p class="code">{{ code.code }}</p>
        <p class="hint">Works once, until {{ fmtDate(code.expiresAt) }}. Once they accept, they see their items, sales and payouts at your stores, can share items with you, and you can import from their catalogue.</p>
      </div>
      <template #footer><div class="footer"><button type="button" class="primary" @click="code = null">Done</button></div></template>
    </ModalShell>

    <ModalShell v-if="editing" :title="editId ? 'Edit artist' : 'New artist'" @close="editing = false">
      <div class="form">
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <label><span>Name</span><input v-model="form.name" type="text" required /></label>
        <label><span>Email (optional)</span><input v-model="form.email" type="email" /></label>
        <label><span>Commission % - what the store keeps</span><input v-model="form.commissionPct" type="number" min="0" max="100" step="0.5" inputmode="decimal" /></label>

        <fieldset>
          <legend>Stores that carry this artist</legend>
          <p v-if="!stores.length" class="hint">No stores yet - add one under Stores.</p>
          <div v-for="s in stores" :key="s.id" class="store-row">
            <label class="check"><input v-model="form.storeIds" type="checkbox" :value="s.id" /> {{ s.name }}<span v-if="s.venue?.city" class="hint"> · {{ s.venue.city }}</span></label>
            <input
              v-if="form.storeIds.includes(s.id)"
              v-model="form.storeCommission[s.id]"
              type="number"
              min="0"
              max="100"
              step="0.5"
              inputmode="decimal"
              :placeholder="`${form.commissionPct || 0}%`"
              :aria-label="`Commission at ${s.name}`"
            />
          </div>
          <p v-if="form.storeIds.length > 1" class="hint">Shared between stores. Leave a store's commission blank to use the default.</p>
        </fieldset>

        <div class="two">
          <label><span>IBAN</span><input v-model="form.iban" type="text" autocomplete="off" placeholder="DK50 0040 0440 1162 43" /></label>
          <label><span>BIC</span><input v-model="form.bic" type="text" autocomplete="off" placeholder="Optional" /></label>
        </div>
        <small class="hint">Where you pay this artist - used for the bank payment file under Reports.</small>
        <label><span>Note</span><textarea v-model="form.note" rows="2" placeholder="Agreement, pickup schedule…" /></label>
        <label v-if="editId" class="check"><input v-model="form.archived" type="checkbox" /> Archived - no longer consigning</label>
      </div>
      <template #footer>
        <div class="footer">
          <button v-if="editId" type="button" class="quiet danger" @click="remove(consignors.find((c) => c.id === editId)!)">Remove</button>
          <span class="grow" />
          <button type="button" @click="editing = false">Cancel</button>
          <button type="button" class="primary" :disabled="saving || !form.name.trim()" @click="save">{{ editId ? 'Save' : 'Create' }}</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.bar { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; }
.bar .hint { flex: 1 1 20rem; }
.bar .primary { display: inline-flex; align-items: center; gap: .4rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); font-size: .82rem; margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: .75rem; }
.card { display: flex; flex-direction: column; gap: .3rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.card.archived { opacity: .65; }
.title { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.pill { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; border-radius: 999px; padding: .15rem .5rem; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); }
.pill.linked { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.meta { margin: 0; font-size: .82rem; color: var(--zfy-muted, #5a6472); display: flex; align-items: center; gap: .3rem; }
.actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
.actions button { min-height: 2.2rem; padding: .2rem .7rem; font-size: .78rem; display: inline-flex; align-items: center; gap: .3rem; }
.form { display: flex; flex-direction: column; gap: .7rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.check { flex-direction: row; align-items: center; gap: .4rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.store-row { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
.store-row input[type='number'] { width: 6rem; }
.code { font-size: 1.6rem; font-weight: 700; letter-spacing: .12em; text-align: center; font-variant-numeric: tabular-nums; margin: .3rem 0; }
.footer { display: flex; align-items: center; gap: .5rem; }
.grow { flex: 1; }
.copy-row { display: flex; gap: .4rem; }
.copy-row input { flex: 1; min-width: 0; font-size: .8rem; }
</style>
