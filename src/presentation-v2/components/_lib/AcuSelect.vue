<template>
  <div ref="rootRef" class="acu-select" :class="rootClasses">
    <button type="button" class="acu-select__trigger" :disabled="disabled" @click="open = !open">
      <span class="acu-select__label" :class="{ 'acu-select__label--placeholder': !hasSelection }">{{ selectedLabel }}</span>
      <i class="fa-solid fa-chevron-down acu-select__caret" :class="{ 'acu-select__caret--open': open }"></i>
    </button>
    <ul v-if="open" class="acu-select__menu">
      <li
        v-for="opt in options"
        :key="opt.value"
        class="acu-select__item"
        :class="{ 'acu-select__item--active': opt.value === modelValue }"
        @click="select(opt.value)"
      >
        {{ opt.label }}
      </li>
      <li v-if="!options.length" class="acu-select__empty">无可选项</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { getAcuHostDocument } from '../../bootstrap/host-document';

export interface AcuSelectOption {
  value: string;
  label: string;
}

const props = withDefaults(defineProps<{
  options: AcuSelectOption[];
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}>(), {
  placeholder: '请选择',
  disabled: false,
  size: 'md',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

const rootClasses = computed(() => ({
  'acu-select--sm': props.size === 'sm',
  'acu-select--disabled': props.disabled,
}));

const hasSelection = computed(() => props.options.some(o => o.value === props.modelValue));

const selectedLabel = computed(() => {
  const item = props.options.find(o => o.value === props.modelValue);
  return item ? item.label : props.placeholder;
});

function select(value: string) {
  emit('update:modelValue', value);
  open.value = false;
}

function onClickOutside(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

let hostDoc: Document | null = null;
onMounted(() => {
  hostDoc = getAcuHostDocument();
  hostDoc.addEventListener('mousedown', onClickOutside);
});
onBeforeUnmount(() => {
  hostDoc?.removeEventListener('mousedown', onClickOutside);
});
</script>

<style scoped>
.acu-select {
  position: relative;
  display: block;
  width: 100%;
  min-width: 0;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  outline: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.acu-select__trigger {
  display: flex; align-items: center; gap: 8px; width: 100%;
  min-height: 32px; padding: 6px 9px;
  margin: 0 !important;
  background: var(--acu-bg-2) !important; border: 0 !important;
  border-radius: var(--acu-radius-sm); color: var(--acu-text-1);
  font: inherit; font-size: var(--acu-font-size-body, 12px); cursor: pointer;
  transition: background 0.15s ease, box-shadow 0.15s ease;
  box-shadow: none;
}
.acu-select__trigger:hover {
  background: linear-gradient(var(--acu-hover-overlay), var(--acu-hover-overlay)), var(--acu-bg-2) !important;
}
.acu-select__trigger:focus { outline: none !important; }
.acu-select__trigger:focus:not(:focus-visible) { box-shadow: none !important; }
.acu-select__trigger:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--acu-accent-glow); }
.acu-select__trigger:disabled { opacity: 0.5; cursor: not-allowed; }

.acu-select__label {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
.acu-select__label--placeholder { color: var(--acu-text-3); }

.acu-select__caret { font-size: var(--acu-font-size-micro, 10px); color: var(--acu-text-3); transition: transform 0.15s ease; flex-shrink: 0; }
.acu-select__caret--open { transform: rotate(180deg); }

.acu-select__menu {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 100;
  margin: 0; padding: 4px 0; list-style: none;
  background: var(--acu-bg-1); border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-sm); box-shadow: var(--acu-shadow);
  max-height: 240px; overflow-y: auto;
}

.acu-select__item {
  padding: 8px 12px; cursor: pointer; font-size: var(--acu-font-size-body-lg, 13px);
  color: var(--acu-text-2); transition: background 0.1s ease;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.acu-select__item:hover { background: var(--acu-hover-overlay); color: var(--acu-text-1); }
.acu-select__item--active { color: var(--acu-on-accent); background: var(--acu-accent); }

.acu-select__empty { padding: 12px; text-align: center; color: var(--acu-text-3); font-size: var(--acu-font-size-body, 12px); }

/* ── sm variant ── */
.acu-select--sm .acu-select__trigger { min-height: 26px; padding: 3px 7px; font-size: var(--acu-font-size-caption, 11px); }
.acu-select--sm .acu-select__item { padding: 6px 10px; font-size: var(--acu-font-size-body, 12px); }

.acu-select--disabled { pointer-events: none; opacity: 0.5; }
</style>
