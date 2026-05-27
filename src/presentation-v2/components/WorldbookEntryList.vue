<template>
  <div class="acu-v2-wb-entries">
    <div v-if="loading" class="acu-v2-wb-entries__status">正在加载条目...</div>
    <div v-else-if="groups.length === 0" class="acu-v2-wb-entries__status">
      {{ emptyText }}
    </div>
    <template v-else>
      <AcuDisclosureGroup
        v-for="(group, index) in filteredGroups"
        :key="group.bookName"
        root-class="acu-v2-wb-entry-group"
        header-class="acu-v2-wb-entry-group__header"
        body-class="acu-v2-wb-entry-group__body"
        chevron-class="acu-v2-wb-entry-group__chevron"
        label-class="acu-v2-wb-entry-group__name"
        meta-class="acu-v2-wb-entry-group__meta"
        :label="group.bookName"
        :meta="formatGroupMeta(group)"
        :expanded="group.expanded"
        :body-id="`acu-v2-wb-entry-group-${index}`"
        body-mode="if"
        body-max-height="280px"
        @toggle="$emit('toggle-group', group.bookName)"
      >
        <div
          v-for="entry in group.entries"
          :key="`${group.bookName}-${entry.uid}`"
          class="acu-v2-wb-entry-item"
          :class="{ 'acu-v2-wb-entry-item--disabled': entry.disabled }"
        >
          <AcuCheckbox
            :model-value="entry.checked"
            :label="entry.label"
            :disabled="entry.disabled"
            @update:model-value="onToggle(entry.bookName, entry.uid, $event)"
          />
        </div>
      </AcuDisclosureGroup>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AcuCheckbox from './_lib/AcuCheckbox.vue';
import AcuDisclosureGroup from './_lib/AcuDisclosureGroup.vue';
import type { WorldbookEntryGroup } from '../composables/usePlotWorldbookEntries';

const props = withDefaults(defineProps<{
  groups: WorldbookEntryGroup[];
  filter: string;
  loading: boolean;
  emptyText?: string;
}>(), {
  emptyText: '所选世界书中无可显示的条目。',
});

const emit = defineEmits<{
  (e: 'toggle', bookName: string, uid: number, checked: boolean): void;
  (e: 'toggle-group', bookName: string): void;
}>();

const filteredGroups = computed(() => {
  const q = props.filter.trim().toLowerCase();
  if (!q) return props.groups;
  return props.groups
    .map(g => {
      const bookMatch = g.bookName.toLowerCase().includes(q);
      if (bookMatch) return g;
      const filtered = g.entries.filter(e =>
        e.label.toLowerCase().includes(q) || e.bookName.toLowerCase().includes(q),
      );
      if (filtered.length === 0) return null;
      return { ...g, entries: filtered, expanded: true };
    })
    .filter((g): g is WorldbookEntryGroup => g !== null);
});

function formatGroupMeta(group: WorldbookEntryGroup): string {
  const checkedCount = group.entries.filter(entry => entry.checked).length;
  return `${checkedCount}/${group.entries.length} 条`;
}

function onToggle(bookName: string, uid: number, checked: boolean): void {
  emit('toggle', bookName, uid, checked);
}
</script>

<style scoped>
.acu-v2-wb-entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.acu-v2-wb-entries__status {
  padding: 8px 0;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-body, 12px);
}

.acu-v2-wb-entry-item {
  padding: 3px 10px;
  transition: background 0.08s ease;
}
.acu-v2-wb-entry-item:hover { background: var(--acu-hover-overlay); }
.acu-v2-wb-entry-item--disabled {
  opacity: 0.5;
}
</style>
