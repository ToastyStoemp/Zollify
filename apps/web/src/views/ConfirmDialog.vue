<script setup lang="ts">
import { pendingConfirm } from '@zollify/platform';
</script>

<template>
  <div v-if="pendingConfirm.current" class="backdrop" role="dialog" aria-modal="true">
    <div class="dialog">
      <h2>{{ pendingConfirm.current.title }}</h2>
      <p>{{ pendingConfirm.current.message }}</p>
      <div class="actions">
        <button type="button" @click="pendingConfirm.current.resolve(false)">Cancel</button>
        <button type="button" @click="pendingConfirm.current.resolve(true)">Confirm</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; background: rgba(20,26,34,.45); display: grid; place-items: center; padding: 1rem; }
.dialog { background: var(--zfy-surface, #fff); border-radius: 12px; padding: 1.25rem; max-width: 26rem; width: 100%; display: flex; flex-direction: column; gap: .75rem; }
h2 { margin: 0; font-size: 1.05rem; }
p { margin: 0; color: var(--zfy-muted, #5a6472); }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
</style>
