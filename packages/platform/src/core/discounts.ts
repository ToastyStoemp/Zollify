import { computed, reactive, ref } from 'vue';
import type { DiscountRule } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';

/**
 * Discount rules.
 *
 * Stored by core rather than POS because they reference products and have to
 * survive POS being switched off — a rule is catalogue data that happens to be
 * applied at checkout. POS owns the arithmetic; core owns the rows.
 */

const rules = reactive(new Map<string, DiscountRule>());
const loaded = ref(false);

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Discounts were used while signed out.');
  return account.accountId;
}

export async function loadDiscounts(): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const rows = await db.discounts.toArray();
  rules.clear();
  for (const row of rows) {
    if (!(row as DiscountRule & { deletedAt?: number }).deletedAt) rules.set(row.id, row);
  }
  loaded.value = true;
}

export const discountsLoaded = computed(() => loaded.value);

export const allDiscounts = computed(() =>
  [...rules.values()].sort((a, b) => a.name.localeCompare(b.name)),
);

/** Only rules that should be applied at checkout. */
export const activeDiscounts = computed(() =>
  allDiscounts.value.filter((r) => (r as DiscountRule & { enabled?: boolean }).enabled !== false),
);

export function getDiscount(id: string): DiscountRule | undefined {
  return rules.get(id);
}

export async function upsertDiscount(rule: DiscountRule): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const next = toPlain({ ...rule, updatedAt: Date.now() }) as DiscountRule;
  await db.discounts.put(next);
  rules.set(next.id, next);
  await queueOp({ type: 'discount.upsert', payload: next });
}

/** Soft delete, for the same reason products are: last-write-wins sync. */
export async function deleteDiscount(id: string): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const existing = await db.discounts.get(id);
  if (!existing) return;
  const deletedAt = Date.now();
  await db.discounts.put(toPlain({ ...existing, deletedAt, updatedAt: deletedAt }));
  rules.delete(id);
  await queueOp({ type: 'discount.delete', payload: { id, deletedAt } });
}

export async function replaceDiscounts(rows: DiscountRule[]): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.discounts.bulkPut(rows.map(toPlain));
  for (const row of rows) {
    if ((row as DiscountRule & { deletedAt?: number }).deletedAt) rules.delete(row.id);
    else rules.set(row.id, row);
  }
}

export function resetDiscountCache(): void {
  rules.clear();
  loaded.value = false;
}
