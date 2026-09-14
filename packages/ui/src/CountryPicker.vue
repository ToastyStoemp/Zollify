<script setup lang="ts">
import { COUNTRIES } from '@zollify/shared';
import TypeaheadPicker from './TypeaheadPicker.vue';

/** Country by name or ISO code, with search. `store` picks which the model keeps. */
withDefaults(defineProps<{ modelValue?: string; store?: 'code' | 'name'; placeholder?: string; disabled?: boolean }>(), {
  modelValue: '',
  store: 'name',
  placeholder: 'Country',
  disabled: false,
});
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <TypeaheadPicker :model-value="modelValue" :options="COUNTRIES" :store="store" :placeholder="placeholder" :disabled="disabled" @update:model-value="$emit('update:modelValue', $event)" />
</template>
