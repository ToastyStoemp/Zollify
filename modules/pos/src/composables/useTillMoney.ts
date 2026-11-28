import { computed } from 'vue';
import type { Product } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import { cardFx, cardSettlement, cart, localPrice } from '../cart';

/** Amounts as the till shows them: in the currency the cart charges, and what a card is charged in the base currency. */
export function useTillMoney() {
  const currency = computed(() => cart.currency);
  const money = (n: number): string => fmtPrice(n, currency.value);
  const price = (pid: string, vid: string | null, base: number): string => money(localPrice(pid, vid, base));
  const fromPrice = (p: Product): string => `from ${money(Math.min(...(p.variants ?? []).map((v) => localPrice(p.id, v.id, v.price ?? p.price))))}`;

  /** "32.15 EUR on the card" for a local amount, when cards are charged in the base currency. */
  function onCard(localAmount: number): string {
    const s = cardSettlement(localAmount);
    return s ? fmtPrice(s.amount, s.currency) : '';
  }
  const cardRateLabel = computed(() => {
    if (!cardFx.rate) return '';
    const age = Date.now() - cardFx.at > 86_400_000 ? ` · rate from ${new Date(cardFx.at).toLocaleDateString()}` : '';
    return `1 ${cart.baseCurrency} = ${cardFx.rate.toFixed(4)} ${cart.currency}${age}`;
  });
  return { currency, money, price, fromPrice, onCard, cardRateLabel };
}
