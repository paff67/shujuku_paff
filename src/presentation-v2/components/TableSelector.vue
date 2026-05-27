<template>
  <div class="acu-v2-table-selector">
    <div v-if="!sheetKeys.length" class="acu-v2-table-selector__empty">{{ emptyText }}</div>
    <template v-else>
      <div class="acu-v2-table-selector__actions">
        <AcuButton size="sm" @click="$emit('select-all')">全选</AcuButton>
        <AcuButton size="sm" @click="$emit('select-none')">全不选</AcuButton>
        <span class="acu-v2-table-selector__count">已选 {{ selectedKeys.length }} / {{ sheetKeys.length }}</span>
      </div>
      <div class="acu-v2-table-selector__grid">
        <div
          v-for="key in sheetKeys"
          :key="key"
          class="acu-v2-table-selector__item"
        >
          <AcuCheckbox
            :model-value="selectedSet.has(key)"
            :label="nameFor(key)"
            @update:model-value="toggle(key, $event)"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AcuButton from './_lib/AcuButton.vue';
import AcuCheckbox from './_lib/AcuCheckbox.vue';

const props = defineProps<{
  sheetKeys: string[];
  selectedKeys: string[];
  sheetNames: Record<string, string>;
  emptyText?: string;
}>();

const emit = defineEmits<{
  (e: 'update:selectedKeys', value: string[]): void;
  (e: 'select-all'): void;
  (e: 'select-none'): void;
}>();

const selectedSet = computed<Set<string>>(() => new Set(props.selectedKeys));
const emptyText = computed(() => props.emptyText || '尚无可选表格。');

function nameFor(key: string): string {
  return props.sheetNames?.[key] || key;
}

function toggle(key: string, checked: boolean): void {
  const set = new Set(props.selectedKeys);
  if (checked) set.add(key);
  else set.delete(key);
  // preserve original order
  const ordered = props.sheetKeys.filter(k => set.has(k));
  emit('update:selectedKeys', ordered);
}
</script>

<style scoped>
.acu-v2-table-selector { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.acu-v2-table-selector__empty {
  padding: 10px 0; color: var(--acu-text-3); font-size: var(--acu-font-size-body, 12px);
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--acu-text-3) 14%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--acu-text-3) 14%, transparent);
  border-radius: 0;
  background: transparent;
}
.acu-v2-table-selector__actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.acu-v2-table-selector__count { color: var(--acu-text-3); font-size: var(--acu-font-size-body, 12px); }
.acu-v2-table-selector__grid {
  display: grid; gap: 6px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  max-height: 240px; overflow: auto;
  padding: 0;
  border: 0; border-radius: 0;
  background: transparent;
}
.acu-v2-table-selector__item {
  padding: 8px 10px;
  border: 0; border-radius: var(--acu-radius-sm);
  background: transparent; min-width: 0;
}
</style>
