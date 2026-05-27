<template>
  <div class="acu-v2-wb-entry-toolbar">
    <AcuButton @click="$emit('select-all')">全选</AcuButton>
    <AcuButton @click="$emit('deselect-all')">全不选</AcuButton>
    <AcuFormRow class="acu-v2-wb-entry-toolbar__filter">
      <AcuInput
        :model-value="filter"
        type="text"
        placeholder="搜索条目..."
        @update:model-value="$emit('update:filter', String($event))"
      />
    </AcuFormRow>
  </div>
</template>

<script setup lang="ts">
import AcuButton from './_lib/AcuButton.vue';
import AcuFormRow from './_lib/AcuFormRow.vue';
import AcuInput from './_lib/AcuInput.vue';

defineProps<{
  filter: string;
}>();

defineEmits<{
  (e: 'update:filter', value: string): void;
  (e: 'select-all'): void;
  (e: 'deselect-all'): void;
}>();
</script>

<style scoped>
.acu-v2-wb-entry-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  flex-wrap: wrap;
}

.acu-v2-wb-entry-toolbar__filter {
  flex: 1;
  min-width: 160px;
}
</style>
