<template>
  <AcuPanel
    :title="tableCopy.panels.templatePreset.title"
    :description="tableCopy.panels.templatePreset.description"
  >
    <AcuMessage v-if="templates.message.value" :kind="templates.message.value.kind">
      {{ templates.message.value.text }}
    </AcuMessage>
    <AcuMessage v-if="management.message.value" :kind="management.message.value.kind">
      {{ management.message.value.text }}
    </AcuMessage>

    <AcuText variant="status-line" class="acu-table-template-panel__status-line">
      当前聊天: <strong class="acu-text__value">{{ templates.selectedChatPreset.value || '默认预设' }}</strong>
      <template v-if="templates.selectedGlobalPreset.value"> · 全局默认: <strong class="acu-text__value">{{ templates.selectedGlobalPreset.value }}</strong></template>
      <template v-else> · 全局默认: <strong class="acu-text__value">默认预设</strong></template>
      <AcuBadge :variant="templates.isChatOverridden.value ? 'accent' : 'neutral'">
        {{ templates.isChatOverridden.value ? '已覆盖' : '跟随全局' }}
      </AcuBadge>
    </AcuText>

    <div class="acu-table-template-panel__preset-row">
      <AcuPresetDropdown
        :items="templates.chatPresetItems.value"
        :model-value="templates.selectedChatPreset.value"
        :default-name="templates.selectedGlobalPreset.value"
        :disabled="templates.busy.value || management.busy.value"
        placeholder="默认预设"
        @update:model-value="templates.selectChatPreset($event)"
        @set-default="templates.selectGlobalPreset($event)"
      />
      <AcuFileButton
        icon-only
        title="导入模板 JSON"
        accept="application/json,.json"
        :disabled="templates.busy.value || management.busy.value"
        @file="templates.importPresetForCurrentChat($event)"
      >
        <i class="fa-solid fa-file-import"></i>
      </AcuFileButton>
      <AcuButton
        icon-only
        title="管理表格模板预设"
        :disabled="management.busy.value"
        @click="management.openManage"
      >
        <i class="fa-solid fa-gear"></i>
      </AcuButton>
    </div>

    <div class="acu-table-template-panel__action-area">
      <AcuButton
        variant="primary"
        class="acu-table-template-panel__visualizer-button"
        title="打开可视化表格编辑器"
        :disabled="templates.busy.value || management.busy.value"
        @click="management.openVisualizer"
      >
        <i class="fa-solid fa-table-columns"></i>
        打开可视化表格编辑器
      </AcuButton>
    </div>

    <TablePresetDrawer
      :is-open="management.isDrawerOpen.value"
      :title="management.title.value"
      :busy="management.busy.value"
      :message="management.message.value"
      :preset-meta="management.presetMeta.value"
      :default-preset-name="management.defaultPresetName.value"
      @close="management.closeDrawer"
      @create-blank="management.createBlankPreset"
      @set-default="management.setAsDefault($event)"
      @export="management.exportPreset($event)"
      @rename="management.renamePreset($event)"
      @edit="management.editPreset($event)"
      @delete="management.deletePreset($event)"
    />
  </AcuPanel>
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue';
import AcuBadge from './_lib/AcuBadge.vue';
import AcuButton from './_lib/AcuButton.vue';
import AcuFileButton from './_lib/AcuFileButton.vue';
import AcuMessage from './_lib/AcuMessage.vue';
import AcuPanel from './_lib/AcuPanel.vue';
import AcuPresetDropdown from './_lib/AcuPresetDropdown.vue';
import AcuText from './_lib/AcuText.vue';
import TablePresetDrawer from './TablePresetDrawer.vue';
import { useChatChangedTick } from '../composables/useChatChangedListener';
import { useTablePresetManagement } from '../composables/useTablePresetManagement';
import { useTableTemplatePresets } from '../composables/useTableTemplatePresets';
import { tableCopy } from '../copy/table-copy';

const templates = useTableTemplatePresets();
const management = useTablePresetManagement();

function refreshAll(): void {
  templates.refresh();
  management.refresh();
}

onMounted(refreshAll);
watch(useChatChangedTick(), refreshAll);
</script>

<style scoped>
.acu-table-template-panel__status-line {
  margin: 0 0 10px;
}

.acu-table-template-panel__preset-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(2, max-content);
  gap: 6px;
  align-items: stretch;
  min-width: 0;
}

.acu-table-template-panel__action-area {
  margin-top: 10px;
}

.acu-table-template-panel__visualizer-button {
  width: 100%;
}

</style>
