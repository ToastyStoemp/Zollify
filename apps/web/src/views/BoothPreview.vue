<script setup lang="ts">
import { computed } from 'vue';
import { boothPreview, type BoothLayout, type PreviewView } from '@zollify/shared';

/** A flat top-down or front drawing of a booth layout, from the panel data alone. */
const props = defineProps<{ layout: BoothLayout; view: PreviewView }>();

const preview = computed(() => boothPreview(props.layout, props.view));
const title = computed(() => (props.view === 'top' ? 'Top-down view of the booth layout' : 'Front view of the booth layout'));
</script>

<template>
  <figure>
    <svg v-if="preview.shapes.length" :viewBox="`0 0 ${preview.width} ${preview.height}`" role="img" :aria-label="title" preserveAspectRatio="xMidYMid meet">
      <rect
        v-for="(s, i) in preview.shapes"
        :key="i"
        :x="s.x"
        :y="s.y"
        :width="s.w"
        :height="s.h"
        :class="s.kind"
        :style="s.color ? { fill: s.color, stroke: s.color } : undefined"
        :fill-opacity="s.kind === 'shelf' ? 0.25 : s.material === 'mesh' ? 0.45 : 0.9"
      >
        <title v-if="s.label">{{ s.label }}</title>
      </rect>
    </svg>
    <p v-else class="empty">No panels yet.</p>
    <figcaption>{{ view === 'top' ? 'Top (back of booth at the top)' : 'Front' }}</figcaption>
  </figure>
</template>

<style scoped>
figure { margin: 0; display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
svg { width: 100%; max-height: 14rem; background: var(--zfy-bg, #f1f4f6); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; }
rect.panel { stroke-width: .6; }
rect.shelf { stroke-width: .3; }
rect.product { fill: var(--zfy-signal-soft, #e4ecf6); stroke: var(--zfy-ink, #1a2230); stroke-width: .5; stroke-dasharray: 2 1; fill-opacity: .8; }
figcaption, .empty { font-size: .75rem; color: var(--zfy-muted, #5a6472); margin: 0; }
</style>
