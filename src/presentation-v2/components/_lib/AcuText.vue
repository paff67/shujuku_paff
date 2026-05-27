<template>
  <component :is="as" class="acu-text" :class="variantClass">
    <slot />
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';

export type AcuTextVariant =
  | 'caption'
  | 'meta'
  | 'hint'
  | 'status-line'
  | 'empty'
  | 'error'
  | 'section-label'
  | 'list-title';

const props = withDefaults(defineProps<{
  as?: string;
  variant?: AcuTextVariant;
}>(), {
  as: 'p',
  variant: 'meta',
});

const variantClass = computed(() => `acu-text--${props.variant}`);
</script>
