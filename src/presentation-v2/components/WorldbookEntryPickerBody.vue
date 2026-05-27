<template>
  <div class="acu-v2-wb-entry-picker">
    <WorldbookSelector
      :model-value="modelValue"
      :names="names"
      :char-primary="charPrimary"
      :status="selectorStatus"
      :error="selectorError"
      :filterable="filterable"
      :show-character-option="showCharacterOption"
      :character-option-label="characterOptionLabel"
      :character-fallback-label="characterFallbackLabel"
      @update:model-value="$emit('update:modelValue', $event)"
    />
    <p class="acu-v2-wb-entry-picker__hint">
      目前已选: <strong>{{ currentLabel }}</strong>
    </p>

    <WorldbookEntryToolbar
      :filter="filter"
      @update:filter="$emit('update:filter', $event)"
      @select-all="$emit('select-all')"
      @deselect-all="$emit('deselect-all')"
    />
    <WorldbookEntryList
      :groups="groups"
      :filter="filter"
      :loading="loading"
      :empty-text="emptyText"
      @toggle="(bookName: string, uid: number, checked: boolean) => $emit('toggle', bookName, uid, checked)"
      @toggle-group="$emit('toggle-group', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import WorldbookSelector from './WorldbookSelector.vue';
import WorldbookEntryList from './WorldbookEntryList.vue';
import WorldbookEntryToolbar from './WorldbookEntryToolbar.vue';
import type { WorldbookLoadStatus } from '../composables/useWorldbookSelector';

interface WorldbookEntryItem {
  uid: number;
  bookName: string;
  label: string;
  checked: boolean;
  disabled: boolean;
}

interface WorldbookEntryGroup {
  bookName: string;
  entries: WorldbookEntryItem[];
  expanded: boolean;
}

withDefaults(defineProps<{
  modelValue: string;
  names: string[];
  charPrimary: string | null;
  selectorStatus: WorldbookLoadStatus;
  selectorError: string;
  currentLabel: string;
  filter: string;
  groups: WorldbookEntryGroup[];
  loading: boolean;
  emptyText?: string;
  filterable?: boolean;
  showCharacterOption?: boolean;
  characterOptionLabel?: string;
  characterFallbackLabel?: string;
}>(), {
  filterable: true,
  showCharacterOption: true,
  emptyText: '所选世界书中无可显示的条目。',
  characterOptionLabel: undefined,
  characterFallbackLabel: undefined,
});

defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'update:filter', value: string): void;
  (e: 'select-all'): void;
  (e: 'deselect-all'): void;
  (e: 'toggle', bookName: string, uid: number, checked: boolean): void;
  (e: 'toggle-group', bookName: string): void;
}>();
</script>

<style scoped>
.acu-v2-wb-entry-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.acu-v2-wb-entry-picker__hint {
  margin: 0;
  font-size: var(--acu-font-size-caption, 11px);
  color: var(--acu-text-3);
}

.acu-v2-wb-entry-picker__hint strong {
  color: var(--acu-text-1);
  font-weight: 500;
}
</style>
