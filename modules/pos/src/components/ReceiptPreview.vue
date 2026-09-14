<script setup lang="ts">
import type { ReceiptLine } from '../receipt';

/**
 * On-screen render of a thermal receipt (58 mm / 32-char paper). Takes the
 * same ReceiptLine[] the printer gets, so what you see is what prints.
 * Ported from ZollTool.
 */
defineProps<{ lines: ReceiptLine[] }>();
</script>

<template>
  <div class="paper">
    <div class="content">
      <template v-for="(l, i) in lines" :key="i">
        <img v-if="l.kind === 'image'" :src="`data:image/png;base64,${l.imageB64}`" class="logo" alt="Receipt logo" />
        <div v-else-if="l.kind === 'space'" class="space">&nbsp;</div>
        <div v-else :class="['line', { dh: l.doubleHeight }]" :style="{ textAlign: l.align || 'left' }"><span>{{ l.text || ' ' }}</span></div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.paper { display: inline-block; background: #fff; color: #16181d; padding: 16px 12px 22px; border-radius: 5px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); max-width: 100%; overflow-x: auto; }
.content { width: 32ch; font-family: 'Courier New', ui-monospace, monospace; font-size: 11.5px; line-height: 1.35; }
.line { white-space: pre; }
.line.dh { line-height: 2; font-weight: 700; }
.line.dh span { display: inline-block; transform: scaleY(1.7); transform-origin: center; }
.space { height: 0.9em; }
.logo { display: block; width: 100%; margin: 0 auto 5px; }
</style>
