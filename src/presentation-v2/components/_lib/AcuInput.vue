<template>
  <span
    class="acu-input-shell"
    :class="[
      `acu-input-shell--${type}`,
      `acu-input-shell--${size}`,
      { 'acu-input-shell--disabled': disabled },
    ]"
  >
    <input
      :type="type"
      class="acu-input"
      :class="[`acu-input--${size}`, { 'acu-input--disabled': disabled }]"
      :value="displayValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :min="min"
      :max="max"
      :step="step"
      :autocomplete="autocomplete"
      @input="onInput"
      @change="onChangeEvent"
      @wheel="onWheel"
    >
    <span v-if="type === 'number'" class="acu-input__number-indicator" aria-hidden="true">
      <span class="acu-input__number-caret acu-input__number-caret--up"></span>
      <span class="acu-input__number-caret acu-input__number-caret--down"></span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string | number;
  type?: 'text' | 'number' | 'password';
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  min?: number;
  max?: number;
  step?: number;
  autocomplete?: string;
}>(), {
  type: 'text',
  placeholder: undefined,
  disabled: false,
  size: 'md',
  min: undefined,
  max: undefined,
  step: undefined,
  autocomplete: undefined,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number): void;
  (e: 'change', value: string | number): void;
}>();

const displayValue = computed(() =>
  props.modelValue == null ? '' : String(props.modelValue),
);

function parseValue(raw: string): string | number {
  if (props.type === 'number') {
    if (raw === '' || raw === '-') return raw as unknown as number;
    const n = Number(raw);
    return Number.isNaN(n) ? raw as unknown as number : n;
  }
  return raw;
}

function onInput(ev: Event): void {
  const raw = (ev.target as HTMLInputElement | null)?.value ?? '';
  emit('update:modelValue', parseValue(raw));
}

function onChangeEvent(ev: Event): void {
  const raw = (ev.target as HTMLInputElement | null)?.value ?? '';
  emit('change', parseValue(raw));
}

function onWheel(ev: WheelEvent): void {
  if (props.type !== 'number') return;
  const input = ev.currentTarget as HTMLInputElement | null;
  if (!input || input.ownerDocument.activeElement !== input) return;
  ev.preventDefault();
  input.blur();
}
</script>

<style scoped>
.acu-input-shell {
  position: relative;
  display: block;
  width: 100%;
  min-width: 0;
}

.acu-input {
  width: 100%; box-sizing: border-box;
  border: 0 !important;
  border-radius: var(--acu-radius-sm) !important;
  background: var(--acu-bg-2) !important;
  color: var(--acu-text-1) !important;
  font: inherit !important;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}

.acu-input--md { min-height: 32px; padding: 6px 9px !important; font-size: var(--acu-font-size-body, 12px) !important; }
.acu-input--sm { min-height: 26px; padding: 3px 7px !important; font-size: var(--acu-font-size-caption, 11px) !important; }

.acu-input-shell--number .acu-input--md { padding-right: 30px !important; }
.acu-input-shell--number .acu-input--sm { padding-right: 25px !important; }

.acu-input:hover:not(:disabled) {
  background: linear-gradient(var(--acu-hover-overlay), var(--acu-hover-overlay)), var(--acu-bg-2) !important;
}

.acu-input:focus {
  outline: none;
  box-shadow: 0 0 0 2px var(--acu-accent-glow) !important;
}

.acu-input:disabled,
.acu-input--disabled { opacity: 0.5; cursor: not-allowed; }

.acu-input[type="number"] {
  -moz-appearance: textfield;
  font-variant-numeric: tabular-nums;
}
.acu-input[type="number"]::-webkit-inner-spin-button,
.acu-input[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none; margin: 0;
}

.acu-input__number-indicator {
  position: absolute;
  top: 50%;
  right: 9px;
  width: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--acu-text-3);
  pointer-events: none;
  transform: translateY(-50%);
  opacity: 0.8;
}

.acu-input-shell--sm .acu-input__number-indicator {
  right: 7px;
  width: 8px;
  gap: 1px;
}

.acu-input__number-caret {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
}

.acu-input__number-caret--up { border-bottom: 4px solid currentColor; }
.acu-input__number-caret--down { border-top: 4px solid currentColor; }

.acu-input-shell--sm .acu-input__number-caret {
  border-left-width: 3px;
  border-right-width: 3px;
}

.acu-input-shell--sm .acu-input__number-caret--up { border-bottom-width: 3px; }
.acu-input-shell--sm .acu-input__number-caret--down { border-top-width: 3px; }
</style>
