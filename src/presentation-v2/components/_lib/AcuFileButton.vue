<template>
  <span class="acu-file-button">
    <AcuButton v-bind="buttonProps" @click="trigger">
      <slot />
    </AcuButton>
    <input
      ref="inputRef"
      type="file"
      :accept="accept"
      class="acu-file-button__input"
      @change="onChange"
    >
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AcuButton from './AcuButton.vue';

type Variant = 'default' | 'primary' | 'danger';
type Size = 'sm' | 'md';

const props = withDefaults(defineProps<{
  accept?: string;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  iconOnly?: boolean;
  title?: string;
}>(), {
  accept: undefined,
  variant: 'default',
  size: 'md',
  disabled: false,
  iconOnly: false,
  title: undefined,
});

const emit = defineEmits<{
  (e: 'file', file: File): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);

const buttonProps = computed(() => ({
  variant: props.variant,
  size: props.size,
  disabled: props.disabled,
  iconOnly: props.iconOnly,
  title: props.title,
}));

function trigger(): void {
  inputRef.value?.click();
}

function onChange(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit('file', file);
  input.value = '';
}
</script>

<style scoped>
.acu-file-button { display: inline-flex; }
.acu-file-button__input { display: none; }
</style>
