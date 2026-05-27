<template>
  <section class="acu-v2-plot-page">
    <AcuPanelGrid class="acu-v2-plot-page__grid">
      <PlotPresetPanel />

      <!-- 世界书选择 -->
      <AcuPanel
        :title="plotCopy.panels.worldbook.title"
        :description="plotCopy.panels.worldbook.description"
      >
        <WorldbookEntryPickerBody
          :model-value="plotWorldbook.selectorValue.value"
          :names="worldbook.names.value"
          :char-primary="worldbook.charPrimary.value"
          :selector-status="worldbook.status.value"
          :selector-error="worldbook.error.value"
          :character-option-label="plotCharacterOptionLabel"
          character-fallback-label="当前角色卡所有世界书"
          :current-label="currentWorldbookLabel"
          v-model:filter="entryFilter"
          :groups="wbEntries.groups.value"
          :loading="wbEntries.status.value === 'loading'"
          :empty-text="entryEmptyText"
          @update:model-value="onWorldbookChange($event)"
          @select-all="wbEntries.selectAll()"
          @deselect-all="wbEntries.deselectAll()"
          @toggle="(bookName: string, uid: number, checked: boolean) => wbEntries.toggleEntry(bookName, uid, checked)"
          @toggle-group="wbEntries.toggleGroupExpanded($event)"
        />
      </AcuPanel>
    </AcuPanelGrid>

  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AcuPanel from '../components/_lib/AcuPanel.vue';
import AcuPanelGrid from '../components/_lib/AcuPanelGrid.vue';
import PlotPresetPanel from '../components/PlotPresetPanel.vue';
import WorldbookEntryPickerBody from '../components/WorldbookEntryPickerBody.vue';
import { useWorldbookSelector } from '../composables/useWorldbookSelector';
import { usePlotWorldbookConfig } from '../composables/usePlotWorldbookConfig';
import { usePlotWorldbookEntries } from '../composables/usePlotWorldbookEntries';
import { useChatChangedTick } from '../composables/useChatChangedListener';
import { plotCopy } from '../copy/plot-copy';

const worldbook = useWorldbookSelector();
const plotWorldbook = usePlotWorldbookConfig();
const wbEntries = usePlotWorldbookEntries();
const entryFilter = ref('');
const entryEmptyText = ref(plotCopy.worldbook.emptyDefault);
const plotCharacterOptionLabel = computed<string>(() =>
  worldbook.charPrimary.value
    ? `当前角色卡所有世界书 · 主册 ${worldbook.charPrimary.value}`
    : '当前角色卡所有世界书',
);

async function refreshWorldbookEntries(): Promise<void> {
  const names = await plotWorldbook.resolveBookNames();
  entryEmptyText.value = resolveEntryEmptyText(names);
  await wbEntries.loadEntries(names);
}

function resolveEntryEmptyText(names: string[]): string {
  if (plotWorldbook.source.value === 'character' && names.length === 0) {
    return plotCopy.worldbook.emptyCharacter;
  }
  if (plotWorldbook.source.value === 'manual' && !plotWorldbook.manualBook.value) {
    return plotCopy.worldbook.emptyManual;
  }
  return plotCopy.worldbook.emptyDefault;
}

function onWorldbookChange(value: string): void {
  plotWorldbook.onSelectorChange(value);
  void refreshWorldbookEntries();
}

const currentWorldbookLabel = computed<string>(() => {
  if (plotWorldbook.source.value === 'character') {
    return worldbook.charPrimary.value
      ? `角色卡所有世界书 · 主册 ${worldbook.charPrimary.value}`
      : '角色卡所有世界书';
  }
  return plotWorldbook.manualBook.value || '（未选择）';
});

async function refreshAll(): Promise<void> {
  plotWorldbook.refreshFromSettings();
  await worldbook.refresh();
  void refreshWorldbookEntries();
}

onMounted(() => { void refreshAll(); });

watch(useChatChangedTick(), () => { void refreshAll(); });
</script>

<style scoped>
.acu-v2-plot-page { min-height: 100%; min-width: 0; padding: 20px; display: flex; flex-direction: column; gap: 18px; }

@media (max-width: 860px) {
  .acu-v2-plot-page { padding: 14px; }
}
</style>
