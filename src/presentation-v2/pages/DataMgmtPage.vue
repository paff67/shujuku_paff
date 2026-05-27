<template>
  <section class="acu-v2-data-mgmt-page">
    <AcuMessage v-if="flow.message.value" :kind="flow.message.value.kind">
      {{ flow.message.value.text }}
    </AcuMessage>

    <AcuPanelGrid class="acu-v2-data-mgmt-page__layout">
      <div class="acu-v2-data-mgmt-page__panel-stack">
        <AcuPanel
          :title="dataMgmtCopy.panels.isolation.title"
          :description="dataMgmtCopy.panels.isolation.description"
        >
          <div class="acu-v2-data-mgmt-page__form-stack">
            <AcuFormRow label="标识代码" :hint="isolationCodeHint">
              <AcuInput
                :model-value="flow.isolationCode.value"
                type="text"
                placeholder="输入标识代码"
                @update:model-value="flow.isolationCode.value = String($event)"
              />
            </AcuFormRow>

            <AcuDisclosureGroup
              class="acu-v2-data-mgmt-page__history"
              label="历史标识"
              :meta="historyMetaLabel"
              :expanded="historyExpanded"
              body-id="acu-data-isolation-history"
              body-mode="if"
              @toggle="historyExpanded = !historyExpanded"
            >
              <div
                v-if="flow.isolationHistory.value.length"
                class="acu-v2-data-mgmt-page__history-list"
              >
                <div
                  v-for="code in flow.isolationHistory.value"
                  :key="code"
                  class="acu-v2-data-mgmt-page__history-item"
                >
                  <AcuButton
                    class="acu-v2-data-mgmt-page__history-fill"
                    size="sm"
                    :title="`填入历史标识：${code}`"
                    :disabled="!!flow.busyAction.value"
                    @click="selectHistory(code)"
                  >
                    <span class="acu-v2-data-mgmt-page__history-code">{{
                      code
                    }}</span>
                    <span
                      v-if="code === flow.currentIsolationLabel.value"
                      class="acu-v2-data-mgmt-page__history-current"
                    >
                      当前
                    </span>
                  </AcuButton>
                  <AcuIconButton
                    icon="fa-solid fa-trash-can"
                    variant="danger"
                    :title="`删除历史标识：${code}`"
                    :aria-label="`删除历史标识：${code}`"
                    :disabled="!!flow.busyAction.value"
                    @click="onRemoveHistory(code)"
                  />
                </div>
              </div>
              <p v-else class="acu-v2-data-mgmt-page__history-empty">
                暂无历史标识。
              </p>
            </AcuDisclosureGroup>
          </div>

          <div class="acu-v2-data-mgmt-page__actions">
            <AcuButton
              :loading="flow.busyAction.value === 'delete-isolation-entries'"
              @click="onDeleteCurrentIsolationEntries"
            >
              删除当前标识注入条目
            </AcuButton>
            <AcuButton
              variant="primary"
              :loading="flow.busyAction.value === 'apply-isolation'"
              @click="onApplyIsolation"
            >
              保存并应用
            </AcuButton>
          </div>
        </AcuPanel>

        <AcuPanel
          :title="dataMgmtCopy.panels.backup.title"
          :description="dataMgmtCopy.panels.backup.description"
        >
          <div class="acu-v2-data-mgmt-page__command-grid">
            <AcuFileButton
              variant="primary"
              accept=".json,application/json"
              :disabled="!!flow.busyAction.value"
              @file="flow.importCombinedSettings"
            >
              合并导入（模板+指令）
            </AcuFileButton>
            <AcuButton
              :disabled="!!flow.busyAction.value"
              @click="flow.exportCombinedSettings"
            >
              合并导出（模板+指令）
            </AcuButton>
            <AcuButton
              :disabled="!!flow.busyAction.value"
              @click="flow.exportJsonData"
            >
              特殊导出
            </AcuButton>
            <AcuButton
              :loading="flow.busyAction.value === 'override-latest'"
              @click="onOverrideLatestLayer"
            >
              模板覆盖最新层数据
            </AcuButton>
          </div>
        </AcuPanel>
      </div>

      <div class="acu-v2-data-mgmt-page__panel-stack">
        <AcuPanel
          :title="dataMgmtCopy.panels.cleanup.title"
          :description="dataMgmtCopy.panels.cleanup.description"
        >
          <section
            class="acu-v2-data-mgmt-page__cleanup-section"
            aria-labelledby="acu-cleanup-auto-title"
          >
            <h3
              id="acu-cleanup-auto-title"
              class="acu-v2-data-mgmt-page__section-title"
            >
              自动清理
            </h3>
            <div class="acu-v2-data-mgmt-page__form-stack">
              <AcuFormRow
                label="保留数据层数"
                hint="自动更新结束后，超过保留范围的旧楼层插件数据会被清理；不影响聊天正文。"
              >
                <AcuInput
                  type="number"
                  :min="0"
                  :step="1"
                  :model-value="flow.retainRecentLayers.value"
                  @change="flow.setRetainRecentLayers($event)"
                />
              </AcuFormRow>
            </div>
          </section>

          <section
            class="acu-v2-data-mgmt-page__cleanup-section"
            aria-labelledby="acu-cleanup-manual-title"
          >
            <h3
              id="acu-cleanup-manual-title"
              class="acu-v2-data-mgmt-page__section-title"
            >
              手动删除
            </h3>
            <p class="acu-v2-data-mgmt-page__meta">
              当前聊天 {{ flow.aiMessageCount.value }} 个 AI 楼层 · 将处理：{{
                flow.rangeLabel.value
              }}
            </p>

            <div class="acu-v2-data-mgmt-page__form-grid">
              <AcuFormRow
                label="起始楼层"
                hint="从第N个楼层 AI 回复开始，留空为第 1 层。"
              >
                <AcuInput
                  :model-value="flow.deleteRange.startFloor"
                  type="number"
                  :min="1"
                  :step="1"
                  @update:model-value="flow.deleteRange.startFloor = $event"
                />
              </AcuFormRow>
              <AcuFormRow label="终止楼层" hint="留空为最新楼层。">
                <AcuInput
                  :model-value="flow.deleteRange.endFloor"
                  type="number"
                  :min="1"
                  :step="1"
                  placeholder="到最后"
                  @update:model-value="flow.deleteRange.endFloor = $event"
                />
              </AcuFormRow>
            </div>

            <div
              class="acu-v2-data-mgmt-page__command-grid acu-v2-data-mgmt-page__command-grid--cleanup"
            >
              <AcuButton
                :loading="flow.busyAction.value === 'delete-current-local'"
                @click="onDeleteLocalData('current')"
              >
                删除当前标识本地数据
              </AcuButton>
              <AcuButton
                variant="danger"
                :loading="flow.busyAction.value === 'delete-all-local'"
                @click="onDeleteLocalData('all')"
              >
                删除所有本地数据
              </AcuButton>
            </div>
          </section>
        </AcuPanel>
      </div>
    </AcuPanelGrid>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import AcuButton from "../components/_lib/AcuButton.vue";
import AcuDisclosureGroup from "../components/_lib/AcuDisclosureGroup.vue";
import AcuFileButton from "../components/_lib/AcuFileButton.vue";
import AcuFormRow from "../components/_lib/AcuFormRow.vue";
import AcuIconButton from "../components/_lib/AcuIconButton.vue";
import AcuInput from "../components/_lib/AcuInput.vue";
import AcuMessage from "../components/_lib/AcuMessage.vue";
import AcuPanel from "../components/_lib/AcuPanel.vue";
import AcuPanelGrid from "../components/_lib/AcuPanelGrid.vue";
import { useChatChangedTick } from "../composables/useChatChangedListener";
import { useDataManagement } from "../composables/useDataManagement";
import { dataMgmtCopy } from "../copy/data-mgmt-copy";

const flow = useDataManagement();
const historyExpanded = ref(false);

const isolationCodeHint = computed(
  () =>
    `当前正在使用：${flow.currentIsolationLabel.value}。留空表示默认数据；修改后点击“保存并应用”才会切换。`,
);
const historyMetaLabel = computed(
  () => `${flow.isolationHistory.value.length} 个`,
);

function selectHistory(value: string): void {
  if (value) flow.isolationCode.value = value;
}

async function onApplyIsolation(): Promise<void> {
  await flow.applyIsolation();
}

async function onRemoveHistory(code: string): Promise<void> {
  await flow.removeHistory(code);
}

function onDeleteCurrentIsolationEntries(): void {
  if (
    !window.confirm(
      "删除当前标识的数据库注入条目？这不会删除聊天正文，但会移除世界书里的插件生成条目。",
    )
  )
    return;
  void flow.deleteCurrentIsolationEntries();
}

function onOverrideLatestLayer(): void {
  if (
    !window.confirm(
      "用当前生效模板覆盖最新 AI 楼层的表格数据？这会清空模板内表格的数据行，只保留表头。",
    )
  )
    return;
  void flow.overrideLatestLayerWithTemplate();
}

function onDeleteLocalData(mode: "current" | "all"): void {
  const message =
    mode === "all"
      ? `删除当前聊天中 ${flow.rangeLabel.value} 的所有标识数据库数据？此操作不可恢复。`
      : `删除当前聊天中 ${flow.rangeLabel.value} 属于当前标识的数据库数据？此操作不可恢复。`;
  if (!window.confirm(message)) return;
  if (
    mode === "all" &&
    !window.confirm("再次确认：删除所有标识的本地数据库数据？")
  )
    return;
  void flow.deleteLocalData(mode);
}

function refreshAll(): void {
  flow.refresh();
  historyExpanded.value = false;
}

onMounted(refreshAll);
watch(useChatChangedTick(), refreshAll);
</script>

<style scoped>
.acu-v2-data-mgmt-page {
  min-height: 100%;
  min-width: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.acu-v2-data-mgmt-page__panel-stack {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.acu-v2-data-mgmt-page__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.acu-v2-data-mgmt-page__form-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.acu-v2-data-mgmt-page__meta {
  margin: 0;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-body, 12px);
  line-height: 1.55;
}

.acu-v2-data-mgmt-page__cleanup-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.acu-v2-data-mgmt-page__cleanup-section
  + .acu-v2-data-mgmt-page__cleanup-section {
  margin-top: 4px;
  padding-top: 14px;
  border-top: 1px solid var(--acu-border);
}

.acu-v2-data-mgmt-page__section-title {
  margin: 0;
  color: var(--acu-text-1);
  font-size: var(--acu-font-size-body-lg, 13px);
  font-weight: 600;
  line-height: 1.35;
}

.acu-v2-data-mgmt-page__history {
  border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-sm);
  background: color-mix(in srgb, var(--acu-bg-2) 72%, transparent);
}

.acu-v2-data-mgmt-page__history :deep(.acu-disclosure-group__header) {
  border-radius: var(--acu-radius-sm);
}

.acu-v2-data-mgmt-page__history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.acu-v2-data-mgmt-page__history-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.acu-v2-data-mgmt-page__history-fill {
  width: 100%;
  min-width: 0;
  justify-content: flex-start;
}

.acu-v2-data-mgmt-page__history-code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--acu-font-mono, Consolas, Menlo, monospace);
}

.acu-v2-data-mgmt-page__history-current {
  flex-shrink: 0;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-caption, 11px);
}

.acu-v2-data-mgmt-page__history-empty {
  margin: 0;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-caption, 11px);
  line-height: 1.5;
}

.acu-v2-data-mgmt-page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.acu-v2-data-mgmt-page__actions,
.acu-v2-data-mgmt-page__command-grid {
  padding-top: 12px;
  margin-top: 4px;
}

.acu-v2-data-mgmt-page__command-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.acu-v2-data-mgmt-page__command-grid--cleanup {
  margin-top: 12px;
}

.acu-v2-data-mgmt-page__command-grid :deep(.acu-file-button),
.acu-v2-data-mgmt-page__command-grid :deep(.acu-btn) {
  width: 100%;
  min-width: 0;
}

@media (max-width: 860px) {
  .acu-v2-data-mgmt-page {
    padding: 14px;
  }

  .acu-v2-data-mgmt-page__form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .acu-v2-data-mgmt-page__command-grid {
    grid-template-columns: 1fr;
  }
}
</style>
