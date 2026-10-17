<script setup lang="ts">
import SmeExemption from './SmeExemption.vue';

/** First-run setup: the exemption form, saving as it goes (setup's Continue cannot save for a module). */
</script>

<template>
  <p class="lede">You said you are on a small-business scheme. Where does it apply? Change this any time under Settings → SME exemption.</p>
  <SmeExemption autosave />
</template>

<style scoped>
.lede { margin: 0; color: var(--zfy-muted); max-width: 60ch; }
</style>
