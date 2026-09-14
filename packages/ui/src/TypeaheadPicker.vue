<script setup lang="ts">
import { computed, ref } from 'vue';
/**
 * A text input with a searchable dropdown, ported from ZollTool's country and
 * currency pickers. Search matches a code prefix or a name substring; typed
 * text snaps to a known entry on blur so a hand-typed "ch" stores the same
 * value a pick from the list would.
 */
import type { PickerOption } from './picker';

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    options: PickerOption[];
    /** What the model holds: the entry's code or its name. */
    store?: 'code' | 'name';
    placeholder?: string;
    upper?: boolean;
    disabled?: boolean;
  }>(),
  { modelValue: '', store: 'code', placeholder: '', upper: false, disabled: false },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const focusIdx = ref(-1);

const matches = computed(() => {
  const q = props.modelValue.trim().toLowerCase();
  const list = q ? props.options.filter((c) => c.code.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q)) : props.options;
  return list.slice(0, 80);
});

function select(option: PickerOption): void {
  emit('update:modelValue', props.store === 'code' ? option.code : option.name);
  open.value = false;
}
function onInput(e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  emit('update:modelValue', props.upper ? v.toUpperCase() : v);
  open.value = true;
  focusIdx.value = -1;
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    open.value = false;
    return;
  }
  if (!open.value || !matches.value.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusIdx.value = Math.min(focusIdx.value + 1, matches.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusIdx.value = Math.max(focusIdx.value - 1, 0);
  } else if (e.key === 'Enter' && focusIdx.value >= 0) {
    e.preventDefault();
    select(matches.value[focusIdx.value]!);
  }
}
function onBlur(): void {
  // Delay so a mousedown on a dropdown item still lands.
  setTimeout(() => (open.value = false), 160);
  const val = props.modelValue.trim();
  if (!val) return;
  const hit =
    props.options.find((c) => c.code.toLowerCase() === val.toLowerCase()) ??
    props.options.find((c) => c.name.toLowerCase() === val.toLowerCase());
  if (hit) select(hit);
}
</script>

<template>
  <div class="picker">
    <input
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="{ upper }"
      type="text"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      role="combobox"
      :aria-expanded="open && matches.length > 0"
      @input="onInput"
      @focus="open = true"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <div v-if="open && matches.length" class="menu" role="listbox">
      <button v-for="(c, i) in matches" :key="c.code" type="button" role="option" :aria-selected="i === focusIdx" :class="{ focus: i === focusIdx }" @mousedown.prevent="select(c)">
        <span class="code">{{ c.code }}</span>
        <span class="name">{{ c.name }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker { position: relative; }
.picker input { width: 100%; }
.picker input.upper { text-transform: uppercase; }
.menu { position: absolute; left: 0; right: 0; top: 100%; z-index: 40; margin-top: .25rem; max-height: 14rem; overflow-y: auto; border-radius: 10px; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); box-shadow: 0 12px 28px -12px var(--zfy-shadow, rgba(20,26,34,.35)); }
.menu button { display: flex; align-items: center; gap: .5rem; width: 100%; min-height: 2.1rem; padding: .3rem .7rem; text-align: left; border: 0; border-radius: 0; background: none; font-size: .875rem; color: var(--zfy-ink, #1a2230); }
.menu button:hover, .menu button.focus { background: var(--zfy-bg, #f1f4f6); }
.code { flex: 0 0 2.6rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .75rem; color: var(--zfy-accent-ink, #0a5a4a); }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
