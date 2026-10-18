<script setup lang="ts">
import SmeExemptionForm from './SmeExemptionForm.vue';

/** First-run setup: the exemption, saving as it goes (the wizard's Continue does not save for it). */
</script>

<template>
  <p class="lede">You said you are on a small-business scheme. Where does it apply? Change this any time under Settings → VAT.</p>
  <SmeExemptionForm autosave />
</template>

<style scoped>
.lede { margin: 0; color: var(--zfy-muted); max-width: 60ch; }
</style>
