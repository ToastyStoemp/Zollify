import { computed, ref, watch } from 'vue';
import { currentAccount, fetchLatestRate, getSalesEvent, recentTransactions } from '@zollify/platform';
import { buildSmeYear, countryCodeOf, thresholdRatePairs, thresholdWarnings, type SmeReport, type ThresholdWarning } from '@zollify/shared';

/**
 * Small-business threshold warnings for the signed-in business: how close
 * each exempt country (and the EU-wide EUR 100,000) is, from every sale
 * recorded this year and last. Rates for thresholds in another currency
 * (DKK, SEK, ...) are fetched once per pair; a pair with no rate leaves that
 * country out rather than guessing.
 *
 * Empty for a business that is not exempt anywhere.
 */
export function useThresholdWarnings() {
  const profile = computed(() => currentAccount.value?.profile);
  const exempt = computed(() => profile.value?.vat?.exemptCountries ?? []);
  const year = new Date().getFullYear();

  const reports = computed<{ thisYear: SmeReport; lastYear: SmeReport } | null>(() => {
    if (!exempt.value.length) return null;
    const input = { transactions: recentTransactions.value, eventOf: (id: string) => getSalesEvent(id), profile: profile.value };
    return { thisYear: buildSmeYear(year, input), lastYear: buildSmeYear(year - 1, input) };
  });

  const rates = ref(new Map<string, number>());
  watch(
    () => (reports.value ? thresholdRatePairs([reports.value.thisYear, reports.value.lastYear], profile.value).map((p) => p.join('>')).join(',') : ''),
    async (keys) => {
      for (const key of keys ? keys.split(',') : []) {
        if (rates.value.has(key)) continue;
        const [from, to] = key.split('>') as [string, string];
        const r = await fetchLatestRate(from, to).catch(() => null);
        if (r) rates.value = new Map(rates.value).set(key, r.rate);
      }
    },
    { immediate: true },
  );

  const warnings = computed<ThresholdWarning[]>(() => {
    if (!reports.value) return [];
    return thresholdWarnings({
      ...reports.value,
      profile: profile.value,
      home: countryCodeOf(profile.value?.artist?.countryOfOrigin),
      rate: (from, to) => rates.value.get(`${from}>${to}`) ?? null,
    });
  });

  /** This year's reported turnover per exempt country, in each row's book currency - for Settings → VAT. */
  const thisYearBy = computed(() => {
    const out = new Map<string, { amount: number; currency: string }>();
    for (const row of reports.value?.thisYear.rows ?? []) {
      const prev = out.get(row.country);
      if (!prev || prev.currency === row.currency) out.set(row.country, { amount: (prev?.amount ?? 0) + row.reported, currency: row.currency });
    }
    return out;
  });

  return { warnings, thisYearBy };
}
