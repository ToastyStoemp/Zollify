<script setup lang="ts">
import { CURRENCIES } from '@zollify/shared';
import TypeaheadPicker from './TypeaheadPicker.vue';

/** ISO currency code with search by code or name. */
withDefaults(defineProps<{ modelValue?: string; placeholder?: string; disabled?: boolean }>(), { modelValue: '', placeholder: 'CHF', disabled: false });
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <TypeaheadPicker :model-value="modelValue" :options="CURRENCIES" store="code" upper :placeholder="placeholder" :disabled="disabled" @update:model-value="$emit('update:modelValue', $event)" />
</template>
