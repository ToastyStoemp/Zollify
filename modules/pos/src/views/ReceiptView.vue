<script setup lang="ts">
defineProps<{ saleId?: string }>();

function print(): void {
  window.print();
}
</script>

<template>
  <section class="receipt">
    <h1>Receipt</h1>
    <p class="hint">Sale {{ saleId ?? '—' }}</p>
    <button type="button" @click="print">Print receipt</button>
  </section>
</template>

<style scoped>
.receipt { display: flex; flex-direction: column; gap: .75rem; }
h1 { font-size: 1.25rem; margin: 0; }
.hint { color: var(--bly-muted, #5a6472); margin: 0; font-variant-numeric: tabular-nums; }
</style>
