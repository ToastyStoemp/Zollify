<script setup lang="ts">
import { ref } from 'vue';
import { isBelgianEnterpriseNumber, normaliseBelgianVat, type PeppolParty } from '@zollify/shared';
import { lookupPeppol } from '../api';

/**
 * A business's details as an invoice needs them, for you or a customer:
 * name, address, VAT and enterprise number, and where it receives Peppol
 * documents - with a check against the public Peppol Directory.
 */
const party = defineModel<PeppolParty>({ required: true });
/**
 * The business profile's values, when this is the seller. A blank field then
 * reads as "same as the profile", shown as the placeholder; only a value that
 * differs is kept.
 */
const props = defineProps<{ profile?: Partial<PeppolParty> }>();
const ph = (k: keyof PeppolParty, fallback = ''): string => props.profile?.[k]?.toString() || fallback;

const SCHEMES = [
  { id: '0208', label: 'Belgian enterprise number (0208)' },
  { id: '9925', label: 'Belgian VAT number (9925)' },
  { id: '0106', label: 'Dutch KvK (0106)' },
  { id: '9944', label: 'Dutch VAT (9944)' },
  { id: '0088', label: 'GLN (0088)' },
  { id: '0184', label: 'Danish CVR (0184)' },
  { id: '9930', label: 'German VAT (9930)' },
];

const lookup = ref<string | null>(null);
async function check(): Promise<void> {
  lookup.value = 'Checking…';
  try {
    const r = await lookupPeppol(party.value.peppolScheme || ph('peppolScheme', '0208'), party.value.peppolId || ph('peppolId'));
    lookup.value = r.registered === null ? (r.message ?? 'Could not check.') : r.registered ? `On Peppol${r.name ? ` as ${r.name}` : ''}.` : 'Not found on Peppol - they cannot receive Peppol invoices yet.';
  } catch {
    lookup.value = 'Could not check.';
  }
}
/** A Belgian enterprise number fills in the VAT number and the Peppol identifier, the usual case. */
function fromEnterpriseNumber(): void {
  const p = party.value;
  if ((p.country || ph('country', 'BE')) !== 'BE' || !isBelgianEnterpriseNumber(p.companyId)) return;
  const kbo = p.companyId.replace(/\D/g, '');
  if (!p.vatNumber) p.vatNumber = `BE${kbo}`;
  if (!p.peppolId) {
    p.peppolScheme = '0208';
    p.peppolId = kbo;
  }
}
const kboHint = (): string | null => {
  const p = party.value;
  if ((p.country || ph('country', 'BE')) !== 'BE') return null;
  if (p.companyId && !isBelgianEnterpriseNumber(p.companyId)) return 'Not a valid enterprise number.';
  if (p.vatNumber && !normaliseBelgianVat(p.vatNumber)) return 'Not a valid Belgian VAT number.';
  return null;
};
</script>

<template>
  <div class="party">
    <label class="wide"><span>Name</span><input v-model="party.name" type="text" autocomplete="organization" :placeholder="ph('name')" /></label>
    <label class="wide"><span>Street and number</span><input v-model="party.street" type="text" autocomplete="street-address" :placeholder="ph('street')" /></label>
    <label><span>Postcode</span><input v-model="party.postalCode" type="text" autocomplete="postal-code" :placeholder="ph('postalCode')" /></label>
    <label><span>City</span><input v-model="party.city" type="text" autocomplete="address-level2" :placeholder="ph('city')" /></label>
    <label><span>Country</span><input v-model="party.country" type="text" maxlength="2" :placeholder="ph('country', 'BE')" /></label>
    <label><span>Email</span><input v-model="party.email" type="email" :placeholder="ph('email')" /></label>
    <label><span>{{ (party.country || ph('country', 'BE')) === 'BE' ? 'Enterprise number (KBO/BCE)' : 'Company number' }}</span><input v-model="party.companyId" type="text" :placeholder="ph('companyId', '0123.456.749')" @blur="fromEnterpriseNumber" /></label>
    <label><span>VAT number</span><input v-model="party.vatNumber" type="text" :placeholder="ph('vatNumber', 'BE0123456749')" /></label>
    <p v-if="kboHint()" class="warn wide">{{ kboHint() }}</p>
    <fieldset class="wide">
      <legend>Peppol address</legend>
      <div class="row">
        <select v-model="party.peppolScheme" aria-label="Identifier type">
          <option v-if="profile" value="">{{ profile.peppolScheme ? 'As on your Business profile' : 'Default' }}</option>
          <option v-for="s in SCHEMES" :key="s.id" :value="s.id">{{ s.label }}</option>
        </select>
        <input v-model="party.peppolId" type="text" aria-label="Peppol identifier" :placeholder="ph('peppolId', '0123456749')" />
        <button type="button" :disabled="!(party.peppolId || ph('peppolId'))" @click="check">Check</button>
      </div>
      <small v-if="lookup" class="hint">{{ lookup }}</small>
    </fieldset>
  </div>
</template>

<style scoped>
.party { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem .7rem; }
.party label { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; min-width: 0; }
.wide { grid-column: 1 / -1; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .45rem .7rem .6rem; margin: 0; display: flex; flex-direction: column; gap: .35rem; }
legend { font-size: .78rem; font-weight: 600; padding: 0 .3rem; }
.row { display: flex; gap: .4rem; flex-wrap: wrap; }
.row select { flex: 1 1 12rem; }
.row input { flex: 1 1 9rem; }
.hint { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
.warn { margin: 0; color: var(--zfy-warning-ink, #8a5a1e); font-size: .8rem; }
@media (max-width: 520px) { .party { grid-template-columns: 1fr; } }
</style>
