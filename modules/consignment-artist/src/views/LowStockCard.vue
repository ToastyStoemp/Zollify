<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { restockForecast, type ArtistConsignment } from "@zollify/shared";
import { Icon } from "@zollify/ui";
import { myLinks } from "../api";

/**
 * Home screen: the artist's items running low at the stores they consign
 * with - only what those stores carry of theirs, counted by the store. Low
 * means few left, or selling fast enough to be gone within two weeks.
 */
const LOW = 3;
const SOON_WEEKS = 2;
const links = ref<ArtistConsignment[] | null>(null);
const failed = ref(false);
onMounted(async () => {
  try {
    links.value = (await myLinks()).filter((l) => !l.paused);
  } catch {
    failed.value = true;
  }
});

const stores = computed(() =>
  (links.value ?? []).map((l) => {
    const pace = new Map(
      restockForecast(l.items, l.lines, { weeks: SOON_WEEKS }).map((r) => [
        r.key,
        r,
      ]),
    );
    return {
      id: `${l.storeAccountId}:${l.consignorId}`,
      name: l.storeAccountName,
      low: l.items
        .map((i) => ({
          ...i,
          weeksLeft:
            pace.get(`${i.productId}:${i.variantId}`)?.weeksLeft ?? null,
        }))
        .filter(
          (i) =>
            i.remaining != null &&
            (i.remaining <= LOW ||
              (i.weeksLeft != null && i.weeksLeft < SOON_WEEKS)),
        )
        .sort(
          (a, b) =>
            (a.weeksLeft ?? 99) - (b.weeksLeft ?? 99) ||
            a.remaining! - b.remaining!,
        )
        .slice(0, 6),
      uncounted: l.items.filter((i) => i.remaining == null).length,
      total: l.items.length,
    };
  }),
);
</script>

<template>
  <div class="card-body">
    <header class="head">
      <h2>At my stores</h2>
      <Icon name="store" :size="16" />
    </header>
    <p v-if="failed" class="empty">Could not load your stores.</p>
    <p v-else-if="!links" class="empty">Loading…</p>
    <p v-else-if="!stores.length" class="empty">
      No store sells your work yet.
    </p>
    <section v-for="s in stores" :key="s.id" class="store">
      <span class="label">{{ s.name }}</span>
      <p v-if="!s.total" class="empty">Nothing shared there yet.</p>
      <p v-else-if="!s.low.length" class="empty">Nothing is running low.</p>
      <ul v-else class="list">
        <li v-for="i in s.low" :key="`${i.productId}:${i.variantId}`">
          <span
            >{{ i.title
            }}<template v-if="i.variantLabel">
              · {{ i.variantLabel }}</template
            ></span
          >
          <strong :class="{ bad: i.remaining! <= 0 }"
            >{{ i.remaining! <= 0 ? "sold out" : `${i.remaining} left`
            }}<small v-if="i.remaining! > 0 && i.weeksLeft != null">
              · ~{{ i.weeksLeft }} wk</small
            ></strong
          >
        </li>
      </ul>
      <p v-if="s.uncounted" class="hint">
        {{ s.uncounted }} item{{ s.uncounted === 1 ? "" : "s" }} the store has
        not counted.
      </p>
    </section>
    <footer class="foot">
      <a href="#/m/consignment-artist"
        >My stores <Icon name="chevron-right" :size="14"
      /></a>
    </footer>
  </div>
</template>

<style scoped>
.card-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 1rem;
}
.head .zfy-icon {
  color: var(--zfy-muted);
}
.store {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--zfy-muted);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.list li {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
  font-size: 0.88rem;
}
.list strong {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.list strong.bad {
  color: var(--zfy-danger);
}
.list small {
  font-weight: 400;
  color: var(--zfy-muted);
}
.empty,
.hint {
  margin: 0;
  color: var(--zfy-muted);
  font-size: 0.85rem;
}
.foot {
  display: flex;
  justify-content: flex-end;
}
.foot a {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.85rem;
}
</style>
