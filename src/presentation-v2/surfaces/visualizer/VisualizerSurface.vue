<template>
  <main class="acu-visualizer-surface" data-acu-visualizer-surface>
    <aside class="acu-visualizer-surface__sidebar" aria-label="数据库导航">
      <VisualizerNavigation
        :sheet-items="visualizer.sheetItems"
        :current-sheet-key="visualizer.currentSheetKey"
        :dirty="visualizer.dirty"
        :is-sheet-editing-mode="isSheetEditingMode"
        :mode="visualizer.mode"
        @select-sheet="selectNavSheet"
        @select-table-management="selectTableManagementNav"
      />
    </aside>

    <section
      class="acu-visualizer-surface__main"
      aria-label="数据库编辑器主区域"
    >
      <header class="acu-visualizer-surface__topbar">
        <div
          class="acu-visualizer-surface__topbar-context"
          aria-label="数据库编辑器状态"
        >
          <AcuIconButton
            class="acu-visualizer-surface__mobile-menu"
            icon="fa-solid fa-bars"
            title="打开数据库导航"
            aria-label="打开数据库导航"
            :aria-expanded="isMobileNavOpen"
            @click="openMobileNav"
          />
          <div
            class="acu-visualizer-surface__context-items"
            aria-label="当前编辑上下文"
          >
            <div class="acu-visualizer-surface__context-item">
              <span>当前模板</span>
              <strong>{{ templatePresetLabel }}</strong>
            </div>
            <div
              v-if="visualizer.currentSheetKey && visualizer.currentSheet"
              class="acu-visualizer-surface__context-item"
            >
              <span>当前表</span>
              <strong>{{ currentSheetName }}</strong>
            </div>
          </div>
          <AcuBadge
            v-if="visualizer.externalRevisionChanged"
            class="acu-visualizer-surface__context-badge"
            variant="warning"
          >
            外部数据已变化
          </AcuBadge>
          <AcuBadge
            v-else-if="visualizer.dirty"
            class="acu-visualizer-surface__context-badge"
            variant="warning"
            >未保存</AcuBadge
          >
        </div>

        <AcuSegmentedControl
          v-if="isSheetEditingMode && visualizer.currentSheetKey"
          class="acu-visualizer-surface__mode-tabs"
          :options="modes"
          :model-value="visualizer.mode"
          aria-label="编辑模式"
          @update:model-value="setWorkspaceMode"
        />

        <AcuIconButton
          class="acu-visualizer-surface__close"
          icon="fa-solid fa-xmark"
          title="关闭数据库编辑器"
          aria-label="关闭数据库编辑器"
          @click="emit('close')"
        />
      </header>

      <AcuInfoBanner
        v-if="visualizer.externalRevisionChanged"
        tone="warning"
        class="acu-visualizer-surface__conflict"
      >
        当前聊天的数据在编辑器打开后发生变化。重新载入会丢弃当前草稿；保留草稿则继续编辑，下一次保存会以这里的内容为准。
        <span class="acu-visualizer-surface__conflict-actions">
          <AcuButton size="sm" @click="data.forceReloadFromCurrentContext"
            >重新载入外部数据</AcuButton
          >
          <AcuButton size="sm" @click="visualizer.clearExternalRefreshConflict"
            >保留当前草稿</AcuButton
          >
        </span>
      </AcuInfoBanner>

      <section
        class="acu-visualizer-surface__workspace"
        aria-label="数据库编辑工作区"
      >
        <div
          v-if="visualizer.isLoading"
          class="acu-visualizer-surface__loading"
        >
          <i class="fa-solid fa-spinner fa-spin"></i>
          <span>正在载入当前聊天的表格数据...</span>
        </div>

        <AcuPanel
          v-else-if="visualizer.loadError"
          title="无法载入数据库"
          description="数据库编辑器需要先读取当前聊天或隔离标签下的表格数据。请先完成初始化或一次填表；如果刚切换了聊天，可以重新打开新 UI 再试。"
        >
          <p class="acu-visualizer-surface__empty">
            {{ visualizer.loadError }}
          </p>
          <AcuButton @click="data.forceReloadFromCurrentContext"
            >重新尝试载入</AcuButton
          >
        </AcuPanel>

        <template
          v-else-if="
            visualizer.mode === 'global' ||
            visualizer.mode === 'table-management'
          "
        >
          <div class="acu-visualizer-surface__database-toolbar">
            <div>
              <h2>数据库管理</h2>
            </div>
            <AcuButton
              v-if="visualizer.currentSheetKey"
              size="sm"
              @click="returnToCurrentSheet"
            >
              <i class="fa-solid fa-arrow-left"></i>
              返回当前表编辑
            </AcuButton>
          </div>
          <VisualizerTableManagementPanel
            :sheet-items="visualizer.sheetItems"
            :current-sheet-key="visualizer.currentSheetKey"
            @move-sheet="moveSheet"
            @request-add-sheet="requestAddSheet"
            @request-delete-sheet="requestDeleteSheet"
          />
          <VisualizerGlobalInjectionPanels />
        </template>

        <template v-else>
          <template v-if="visualizer.mode === 'data'">
            <p v-if="rows.length === 0" class="acu-visualizer-surface__empty">
              当前表还没有数据行。可以先新增行，再逐个字段填写内容。
            </p>

            <div v-else class="acu-visualizer-surface__card-grid">
              <article
                v-for="row in rows"
                :key="row.index"
                class="acu-visualizer-surface__data-card"
              >
                <header class="acu-visualizer-surface__card-header">
                  <strong>#{{ row.index + 1 }}</strong>
                  <span>{{ row.fields.length }} 个字段</span>
                  <AcuIconButton
                    class="acu-visualizer-surface__row-lock"
                    icon="fa-solid fa-lock"
                    size="sm"
                    :variant="row.locked ? 'accent' : 'default'"
                    :title="
                      row.locked
                        ? '取消这一行的自动更新保护'
                        : '锁定这一行，阻止自动更新改动整行'
                    "
                    :aria-label="row.locked ? '取消锁定这一行' : '锁定这一行'"
                    @click="
                      visualizer.toggleRowLock(
                        visualizer.currentSheetKey,
                        row.index,
                      )
                    "
                  />
                  <AcuIconButton
                    icon="fa-solid fa-trash"
                    size="sm"
                    variant="danger"
                    title="删除这一行"
                    @click="deleteRow(row.index)"
                  />
                </header>
                <div class="acu-visualizer-surface__fields">
                  <div
                    v-for="fieldRow in row.fieldRows"
                    :key="fieldRow.key"
                    class="acu-visualizer-surface__field-row"
                    :class="{ 'is-wide': fieldRow.wide }"
                    :data-acu-visualizer-field-row-layout="
                      fieldRow.wide ? 'wide' : 'half'
                    "
                  >
                    <label
                      v-for="field in fieldRow.fields"
                      :key="field.columnIndex"
                      class="acu-visualizer-surface__field"
                      :class="{
                        'is-locked': field.locked,
                        'is-special-index': field.specialIndexLocked,
                      }"
                      :data-acu-visualizer-field-layout="
                        fieldRow.wide ? 'wide' : 'half'
                      "
                    >
                      <span class="acu-visualizer-surface__field-label">
                        <span>{{ field.header }}</span>
                        <span class="acu-visualizer-surface__field-locks">
                          <AcuBadge
                            v-if="field.specialIndexLocked"
                            variant="warning"
                            title="编码索引由系统维护；保存、AI 更新或行数变化时会按 AM 序列重排"
                          >
                            自动编号
                          </AcuBadge>
                          <AcuIconButton
                            v-else
                            class="acu-visualizer-surface__lock-button"
                            icon="fa-solid fa-table-columns"
                            size="sm"
                            :variant="field.columnLocked ? 'accent' : 'default'"
                            :title="
                              field.columnLocked
                                ? '取消当前列的自动更新保护'
                                : '锁定当前列，阻止自动更新改动这一列'
                            "
                            :aria-label="
                              field.columnLocked
                                ? '取消锁定当前列'
                                : '锁定当前列'
                            "
                            @click.prevent="
                              visualizer.toggleColumnLock(
                                visualizer.currentSheetKey,
                                field.columnIndex,
                              )
                            "
                          />
                          <AcuIconButton
                            v-if="!field.specialIndexLocked"
                            class="acu-visualizer-surface__lock-button"
                            icon="fa-solid fa-lock"
                            size="sm"
                            :variant="field.cellLocked ? 'accent' : 'default'"
                            :title="
                              field.cellLocked
                                ? '取消当前单元格的自动更新保护'
                                : '锁定当前单元格，阻止自动更新改动这个值'
                            "
                            :aria-label="
                              field.cellLocked
                                ? '取消锁定当前单元格'
                                : '锁定当前单元格'
                            "
                            @click.prevent="
                              visualizer.toggleCellLock(
                                visualizer.currentSheetKey,
                                row.index,
                                field.columnIndex,
                              )
                            "
                          />
                        </span>
                      </span>
                      <AcuTextarea
                        :model-value="field.value"
                        :rows="1"
                        :max-rows="12"
                        auto-resize
                        @update:model-value="
                          (value) =>
                            visualizer.updateCell(
                              row.index,
                              field.columnIndex,
                              value,
                            )
                        "
                      />
                    </label>
                  </div>
                </div>
              </article>
            </div>

            <div class="acu-visualizer-surface__data-toolbar">
              <AcuButton size="sm" variant="primary" @click="addRow">
                <i class="fa-solid fa-plus"></i>
                新增行
              </AcuButton>
            </div>
          </template>

          <VisualizerConfigPanels
            v-else-if="visualizer.mode === 'config'"
            @request-add-column="requestAddColumn"
            @request-delete-column="requestDeleteColumn"
          />

          <VisualizerAssistantPanel v-else />
        </template>
      </section>

      <footer class="acu-visualizer-surface__footer" aria-label="保存操作">
        <span>{{ footerStatus }}</span>
        <div class="acu-visualizer-surface__footer-actions">
          <AcuButton
            :disabled="saveDisabled"
            :loading="visualizer.isSaving"
            @click="save.saveToChat"
          >
            保存到当前聊天
          </AcuButton>
          <AcuButton
            :disabled="saveDisabled"
            :loading="visualizer.isSaving"
            variant="primary"
            @click="save.saveToGlobal"
          >
            保存到全局模板
          </AcuButton>
        </div>
      </footer>
    </section>

    <div
      v-if="isMobileNavRendered"
      class="acu-visualizer-surface__mobile-nav-layer"
      :class="{ 'is-closing': isMobileNavClosing }"
      @click.self="closeMobileNav"
    >
      <aside
        class="acu-visualizer-surface__mobile-nav"
        role="dialog"
        aria-modal="true"
        aria-label="数据库导航"
        @click.stop
      >
        <VisualizerNavigation
          :sheet-items="visualizer.sheetItems"
          :current-sheet-key="visualizer.currentSheetKey"
          :dirty="visualizer.dirty"
          :is-sheet-editing-mode="isSheetEditingMode"
          :mode="visualizer.mode"
          @select-sheet="selectNavSheet"
          @select-table-management="selectTableManagementNav"
        />
      </aside>
    </div>

    <Transition name="acu-visualizer-dialog">
      <div
        v-if="activeDialog"
        class="acu-visualizer-surface__dialog-layer"
        role="presentation"
        @click.self="cancelActiveDialog"
      >
        <section
          class="acu-visualizer-surface__dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="dialogTitleId"
        >
          <header class="acu-visualizer-surface__dialog-header">
            <h2 :id="dialogTitleId">{{ activeDialog.title }}</h2>
            <AcuBadge
              v-if="activeDialog.kind === 'close-dirty'"
              variant="warning"
            >
              未保存
            </AcuBadge>
          </header>

          <p class="acu-visualizer-surface__dialog-message">
            {{ activeDialog.message }}
          </p>

          <label
            v-if="activeDialog.kind === 'input'"
            class="acu-visualizer-surface__dialog-field"
          >
            <span>{{ activeDialog.label }}</span>
            <AcuInput
              v-model="dialogInputValue"
              autocomplete="off"
              :placeholder="activeDialog.placeholder"
              @keyup.enter="confirmInputDialog"
            />
          </label>

          <footer
            v-if="activeDialog.kind === 'close-dirty'"
            class="acu-visualizer-surface__dialog-actions acu-visualizer-surface__dialog-actions--three"
          >
            <AcuButton
              :loading="visualizer.isSaving"
              variant="primary"
              @click="resolveCloseDirtyDialog('save')"
            >
              保存到当前聊天
            </AcuButton>
            <AcuButton
              variant="danger"
              @click="resolveCloseDirtyDialog('discard')"
            >
              丢弃草稿
            </AcuButton>
            <AcuButton @click="resolveCloseDirtyDialog('cancel')">
              取消关闭
            </AcuButton>
          </footer>

          <footer v-else class="acu-visualizer-surface__dialog-actions">
            <AcuButton @click="cancelActiveDialog">
              {{ activeDialog.cancelLabel || "取消" }}
            </AcuButton>
            <AcuButton
              :variant="activeDialog.confirmVariant || 'primary'"
              :disabled="
                activeDialog.kind === 'input' &&
                !String(dialogInputValue).trim()
              "
              @click="confirmActiveDialog"
            >
              {{ activeDialog.confirmLabel }}
            </AcuButton>
          </footer>
        </section>
      </div>
    </Transition>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AcuBadge from "../../components/_lib/AcuBadge.vue";
import AcuButton from "../../components/_lib/AcuButton.vue";
import AcuIconButton from "../../components/_lib/AcuIconButton.vue";
import AcuInfoBanner from "../../components/_lib/AcuInfoBanner.vue";
import AcuInput from "../../components/_lib/AcuInput.vue";
import AcuPanel from "../../components/_lib/AcuPanel.vue";
import AcuSegmentedControl from "../../components/_lib/AcuSegmentedControl.vue";
import AcuTextarea from "../../components/_lib/AcuTextarea.vue";
import { useUiCloseGuard } from "../../composables/useUiCloseGuard";
import { useVisualizerConfigEditing } from "../../composables/visualizer/useVisualizerConfigEditing";
import { useVisualizerData } from "../../composables/visualizer/useVisualizerData";
import { useVisualizerSave } from "../../composables/visualizer/useVisualizerSave";
import { useVisualizerStore } from "../../stores/visualizer-store";
import VisualizerAssistantPanel from "./VisualizerAssistantPanel.vue";
import VisualizerConfigPanels from "./VisualizerConfigPanels.vue";
import VisualizerGlobalInjectionPanels from "./VisualizerGlobalInjectionPanels.vue";
import VisualizerNavigation from "./VisualizerNavigation.vue";
import VisualizerTableManagementPanel from "./VisualizerTableManagementPanel.vue";

const visualizer = useVisualizerStore();
const data = useVisualizerData();
const config = useVisualizerConfigEditing();
const emit = defineEmits<{
  (event: "close"): void;
}>();
type VisualizerDialog =
  | {
      kind: "input";
      title: string;
      message: string;
      label: string;
      placeholder?: string;
      confirmLabel: string;
      cancelLabel?: string;
      confirmVariant?: "default" | "primary" | "danger";
      resolve: (value: string | null) => void;
    }
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel?: string;
      confirmVariant?: "default" | "primary" | "danger";
      resolve: (value: boolean) => void;
    }
  | {
      kind: "close-dirty";
      title: string;
      message: string;
      resolve: (value: "save" | "discard" | "cancel") => void;
    };

const dialogTitleId = "acu-visualizer-dialog-title";
const activeDialog = ref<VisualizerDialog | null>(null);
const dialogInputValue = ref("");
const isMobileNavRendered = ref(false);
const isMobileNavClosing = ref(false);
const VISUALIZER_MOBILE_NAV_LEAVE_MS = 150;
let mobileNavCloseTimer: ReturnType<typeof setTimeout> | undefined;

const save = useVisualizerSave({
  requestGlobalPresetName(defaultName) {
    return openInputDialog({
      title: "保存到全局模板",
      message:
        "当前生效的是默认模板，保存到全局前需要给这份模板起一个名字。取消后不会写入聊天或清掉未保存状态。",
      label: "模板预设名称",
      defaultValue: defaultName,
      placeholder: "例如：当前角色专用模板",
      confirmLabel: "保存到全局",
    });
  },
  confirmOverwriteGlobalPreset(presetName) {
    return openConfirmDialog({
      title: "覆盖全局模板",
      message: `这会用当前编辑结果覆盖全局预设"${presetName}"。如果不确定，可以先取消，当前草稿会继续保留在编辑器里。`,
      confirmLabel: "覆盖并保存",
      confirmVariant: "primary",
    });
  },
});

const modes: Array<{ value: "data" | "config" | "assistant"; label: string }> =
  [
  { value: "data", label: "数据" },
  { value: "config", label: "结构/参数" },
  { value: "assistant", label: "AI 助手" },
];

function setWorkspaceMode(value: string): void {
  if (value === "data" || value === "config" || value === "assistant") {
    visualizer.setMode(value);
  }
}

const isSheetEditingMode = computed(
  () =>
    visualizer.mode === "data" ||
    visualizer.mode === "config" ||
    visualizer.mode === "assistant",
);

const currentSheetName = computed(() =>
  String(
    visualizer.currentSheet?.name || visualizer.currentSheetKey || "未选择表格",
  ),
);

const templatePresetLabel = computed(
  () => data.templatePresetLabel.value || "载入中",
);

const isMobileNavOpen = computed(
  () => isMobileNavRendered.value && !isMobileNavClosing.value,
);

function openMobileNav(): void {
  clearMobileNavCloseTimer();
  isMobileNavRendered.value = true;
  isMobileNavClosing.value = false;
}

function closeMobileNav(): void {
  if (!isMobileNavRendered.value || isMobileNavClosing.value) return;
  isMobileNavClosing.value = true;
  clearMobileNavCloseTimer();
  mobileNavCloseTimer = setTimeout(() => {
    isMobileNavRendered.value = false;
    isMobileNavClosing.value = false;
    mobileNavCloseTimer = undefined;
  }, VISUALIZER_MOBILE_NAV_LEAVE_MS);
}

function clearMobileNavCloseTimer(): void {
  if (mobileNavCloseTimer === undefined) return;
  clearTimeout(mobileNavCloseTimer);
  mobileNavCloseTimer = undefined;
}

function selectNavSheet(key: string): void {
  visualizer.selectSheet(key);
  closeMobileNav();
}

function selectTableManagementNav(): void {
  visualizer.selectTableManagement();
  closeMobileNav();
}

function returnToCurrentSheet(): void {
  if (visualizer.currentSheetKey) visualizer.setMode("data");
}

function moveSheet(key: string, direction: "up" | "down"): void {
  visualizer.moveSheet(key, direction);
}

const headers = computed<string[]>(() => {
  const content = visualizer.currentSheet?.content;
  if (!Array.isArray(content) || !Array.isArray(content[0])) return [];
  return content[0]
    .slice(1)
    .map((item: any, index: number) => String(item || `字段 ${index + 1}`));
});

const VISUALIZER_SHORT_FIELD_CHAR_LIMIT = 24;

function isShortDataField(value: string): boolean {
  const normalized = String(value || "").trim();
  if (normalized.includes("\n") || normalized.includes("\r")) return false;
  return (
    Array.from(normalized.replace(/\s+/g, " ")).length <=
    VISUALIZER_SHORT_FIELD_CHAR_LIMIT
  );
}

function getColumnIsShort(content: any[]): boolean[] {
  return headers.value.map((_, columnIndex) =>
    content
      .slice(1)
      .every((row: any[]) =>
        isShortDataField(
          String(Array.isArray(row) ? (row[columnIndex + 1] ?? "") : ""),
        ),
      ),
  );
}

function buildFieldLayoutRows<T extends { columnIndex: number }>(
  fields: T[],
  columnIsShort: boolean[],
): Array<{ key: string; wide: boolean; fields: T[] }> {
  const result: Array<{ key: string; wide: boolean; fields: T[] }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const next = fields[index + 1];
    const pairWithNext =
      columnIsShort[field.columnIndex] === true &&
      !!next &&
      columnIsShort[next.columnIndex] === true;
    if (pairWithNext && next) {
      result.push({
        key: `${field.columnIndex}-${next.columnIndex}`,
        wide: false,
        fields: [field, next],
      });
      index += 1;
    } else {
      result.push({
        key: String(field.columnIndex),
        wide: true,
        fields: [field],
      });
    }
  }
  return result;
}

const rows = computed(() => {
  const content = visualizer.currentSheet?.content;
  if (!Array.isArray(content)) return [];
  const sheetKey = visualizer.currentSheetKey;
  const specialIndexInfo = config.specialIndex.value;
  const columnIsShort = getColumnIsShort(content);
  return content.slice(1).map((row: any[], index: number) => {
    const fields = headers.value.map((header, columnIndex) => ({
      header,
      columnIndex,
      value: String(Array.isArray(row) ? (row[columnIndex + 1] ?? "") : ""),
      rowLocked: visualizer.isRowLocked(sheetKey, index),
      columnLocked: visualizer.isColumnLocked(sheetKey, columnIndex),
      cellLocked: visualizer.isCellLocked(sheetKey, index, columnIndex),
      specialIndexLocked:
        specialIndexInfo.enabled &&
        specialIndexInfo.index === columnIndex &&
        visualizer.isSpecialIndexLocked(sheetKey),
      locked:
        visualizer.isRowLocked(sheetKey, index) ||
        visualizer.isColumnLocked(sheetKey, columnIndex) ||
        visualizer.isCellLocked(sheetKey, index, columnIndex) ||
        (specialIndexInfo.enabled &&
          specialIndexInfo.index === columnIndex &&
          visualizer.isSpecialIndexLocked(sheetKey)),
    }));
    return {
      index,
      locked: visualizer.isRowLocked(sheetKey, index),
      fields,
      fieldRows: buildFieldLayoutRows(fields, columnIsShort),
    };
  });
});

const footerStatus = computed(() => {
  if (visualizer.isLoading) return "正在读取当前聊天的表格数据。";
  if (visualizer.loadError) return "当前没有可保存的表格草稿。";
  if (visualizer.isSaving) return "正在保存表格数据...";
  if (visualizer.dirty) return "有未保存修改，保存前只存在于编辑器草稿中。";
  if (visualizer.lastSavedAt) return "最近一次保存已完成。";
  return "载入后可以编辑数据卡片，并选择保存到当前聊天或全局模板。";
});

const saveDisabled = computed(
  () => visualizer.isLoading || !!visualizer.loadError || !visualizer.tempData,
);

async function requestAddSheet(): Promise<void> {
  const name = await openInputDialog({
    title: "新增表格",
    message:
      "新表格会先放进当前编辑草稿，只有点击保存后才会写回聊天或全局模板。",
    label: "表格名称",
    defaultValue: "新建表格",
    placeholder: "例如：角色状态",
    confirmLabel: "新增表格",
  });
  if (name) {
    data.addSheet(name);
    closeMobileNav();
  }
}

async function requestDeleteSheet(key: string): Promise<void> {
  const sheet = visualizer.tempData?.[key];
  const name = String(sheet?.name || key);
  const confirmed = await openConfirmDialog({
    title: "删除表格",
    message: `确定要删除表格"${name}"吗？保存后，这张表的数据和模板配置都会被移除。取消后草稿不会变化。`,
    confirmLabel: "删除表格",
    confirmVariant: "danger",
  });
  if (confirmed) data.deleteSheet(key);
}

async function deleteRow(rowIndex: number): Promise<void> {
  const confirmed = await openConfirmDialog({
    title: "删除数据行",
    message: `确定要删除第 ${rowIndex + 1} 行吗？这只会修改当前草稿，保存前仍可通过关闭时取消来保留编辑器。`,
    confirmLabel: "删除这一行",
    confirmVariant: "danger",
  });
  if (!confirmed) return;
  visualizer.deleteRow(rowIndex);
  refreshSpecialIndexColumnDraft();
}

function addRow(): void {
  visualizer.addRow();
  refreshSpecialIndexColumnDraft();
}

function refreshSpecialIndexColumnDraft(): void {
  const sheet = visualizer.currentSheet;
  const info = config.specialIndex.value;
  if (
    !sheet ||
    !info.enabled ||
    !visualizer.isSpecialIndexLocked(visualizer.currentSheetKey)
  )
    return;
  if (!Array.isArray(sheet.content) || info.index < 0) return;
  for (let rowIndex = 1; rowIndex < sheet.content.length; rowIndex += 1) {
    const row = sheet.content[rowIndex];
    if (Array.isArray(row)) {
      row[info.index + 1] = `AM${String(rowIndex).padStart(4, "0")}`;
    }
  }
}

async function requestAddColumn(): Promise<void> {
  const name = await openInputDialog({
    title: "新增列",
    message:
      "新列会加入当前表头，并给已有数据行补一个空值。保存前，这个结构变化只存在于编辑器草稿中。",
    label: "列名",
    defaultValue: "新列",
    placeholder: "例如：状态",
    confirmLabel: "新增列",
  });
  if (name) config.addColumn(name);
}

async function requestDeleteColumn(index: number): Promise<void> {
  const header = headers.value[index] || `第 ${index + 1} 列`;
  const confirmed = await openConfirmDialog({
    title: "删除列",
    message: `确定要删除"${header}"吗？这会同时删除该列在所有数据行里的值。取消后草稿不会变化。`,
    confirmLabel: "删除列",
    confirmVariant: "danger",
  });
  if (!confirmed) return;
  config.deleteColumn(index);
}

useUiCloseGuard(async () => {
  if (!visualizer.isActive || !visualizer.dirty) return true;
  const action = await openCloseDirtyDialog();
  if (action === "cancel") return false;
  if (action === "discard") return true;
  return save.saveToChat();
});

function openInputDialog(options: {
  title: string;
  message: string;
  label: string;
  defaultValue: string;
  placeholder?: string;
  confirmLabel: string;
}): Promise<string | null> {
  dialogInputValue.value = options.defaultValue;
  return new Promise((resolve) => {
    activeDialog.value = {
      kind: "input",
      title: options.title,
      message: options.message,
      label: options.label,
      placeholder: options.placeholder,
      confirmLabel: options.confirmLabel,
      resolve,
    };
  });
}

function openConfirmDialog(options: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: "default" | "primary" | "danger";
}): Promise<boolean> {
  return new Promise((resolve) => {
    activeDialog.value = {
      kind: "confirm",
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel,
      confirmVariant: options.confirmVariant,
      resolve,
    };
  });
}

function openCloseDirtyDialog(): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    activeDialog.value = {
      kind: "close-dirty",
      title: "关闭数据库编辑器",
      message:
        "当前草稿还没有保存。保存会先写入当前聊天再关闭；丢弃会关闭编辑器并清空这次草稿；取消关闭会回到编辑器继续处理。",
      resolve,
    };
  });
}

function cancelActiveDialog(): void {
  const dialog = activeDialog.value;
  activeDialog.value = null;
  if (!dialog) return;
  if (dialog.kind === "input") dialog.resolve(null);
  else if (dialog.kind === "confirm") dialog.resolve(false);
  else dialog.resolve("cancel");
}

function confirmInputDialog(): void {
  const dialog = activeDialog.value;
  if (!dialog || dialog.kind !== "input") return;
  const value = String(dialogInputValue.value || "").trim();
  if (!value) return;
  activeDialog.value = null;
  dialog.resolve(value);
}

function confirmActiveDialog(): void {
  const dialog = activeDialog.value;
  if (!dialog) return;
  if (dialog.kind === "input") {
    confirmInputDialog();
    return;
  }
  if (dialog.kind === "confirm") {
    activeDialog.value = null;
    dialog.resolve(true);
  }
}

function resolveCloseDirtyDialog(value: "save" | "discard" | "cancel"): void {
  const dialog = activeDialog.value;
  if (!dialog || dialog.kind !== "close-dirty") return;
  activeDialog.value = null;
  dialog.resolve(value);
}

onMounted(() => {
  void data.loadFromCurrentContext();
});

onBeforeUnmount(() => {
  clearMobileNavCloseTimer();
});

watch(
  () => visualizer.externalRefreshTick,
  () => {
    if (!visualizer.isActive || visualizer.dirty) return;
    void data.loadFromCurrentContext();
  },
);
</script>

<style scoped>
.acu-visualizer-surface {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  overflow: hidden;
  background: var(--acu-bg-0);
  color: var(--acu-text-1);
}

.acu-visualizer-surface__sidebar {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px 12px 16px;
  overflow-y: auto;
  border-right: 1px solid var(--acu-border-2);
  background: var(--acu-sidebar-bg);
}

.acu-visualizer-surface__main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--acu-bg-0);
}

.acu-visualizer-surface__topbar {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 50px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--acu-border-2);
  background: var(--acu-bg-0);
}

.acu-visualizer-surface__topbar-context {
  min-width: 0;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  gap: 10px;
}

.acu-visualizer-surface__mobile-menu {
  display: none;
  flex: 0 0 auto;
  background: transparent;
  color: var(--acu-text-2);
  box-shadow: none;
}

.acu-visualizer-surface__mobile-menu:hover:not(:disabled) {
  background: transparent;
  color: var(--acu-text-1);
}

.acu-visualizer-surface__context-items {
  min-width: 0;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  justify-content: flex-start;
  gap: 16px;
}

.acu-visualizer-surface__context-item {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.acu-visualizer-surface__context-item:first-child {
  flex: 0 1 auto;
  max-width: min(560px, 42vw);
}

.acu-visualizer-surface__context-item + .acu-visualizer-surface__context-item {
  flex: 0 0 auto;
  max-width: min(260px, 20vw);
}

.acu-visualizer-surface__context-item span {
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-caption, 11px);
  line-height: 1.2;
}

.acu-visualizer-surface__context-item strong {
  min-width: 0;
  overflow: hidden;
  color: var(--acu-text-1);
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acu-visualizer-surface__context-item:first-child strong {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  word-break: break-word;
}

.acu-visualizer-surface__context-badge {
  flex: 0 0 auto;
}

.acu-visualizer-surface__conflict {
  flex: 0 0 auto;
  margin: 12px 16px 0;
}

.acu-visualizer-surface__conflict-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: 8px;
}

.acu-visualizer-surface__data-toolbar,
.acu-visualizer-surface__database-toolbar,
.acu-visualizer-surface__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.acu-visualizer-surface__workspace {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding: 16px;
}

.acu-visualizer-surface__loading {
  min-height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--acu-text-3);
}

.acu-visualizer-surface__mode-tabs {
  flex: 0 0 auto;
  width: min(360px, 42vw);
}

.acu-visualizer-surface__close {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-page-title, 22px);
  line-height: 1;
  border-radius: var(--acu-radius-sm);
}

.acu-visualizer-surface__close:hover {
  background: var(--acu-hover-overlay);
  color: var(--acu-text-1);
}

.acu-visualizer-surface__data-toolbar {
  flex: 0 0 auto;
  justify-content: flex-end;
  padding: 4px 0 0;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-body, 12px);
}

.acu-visualizer-surface__database-toolbar {
  flex: 0 0 auto;
  padding: 0 0 4px;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-body, 12px);
}

.acu-visualizer-surface__database-toolbar h2 {
  margin: 0;
  color: var(--acu-text-1);
  font-size: var(--acu-font-size-page-title, 22px);
  font-weight: 700;
  line-height: 1.2;
}

.acu-visualizer-surface__database-toolbar p {
  margin: 5px 0 0;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-body, 12px);
  line-height: var(--acu-line-height-readable, 1.55);
}

.acu-visualizer-surface__empty {
  margin: 0;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body-lg, 13px);
  line-height: 1.55;
}

.acu-visualizer-surface__card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: 12px;
}

.acu-visualizer-surface__data-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 16px;
  border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-md);
  background: var(--acu-bg-1);
}

.acu-visualizer-surface__card-header strong {
  color: var(--acu-text-1);
  font-family: var(--acu-font-mono);
  font-size: var(--acu-font-size-panel-title, 15px);
}

.acu-visualizer-surface__card-header span {
  min-width: 0;
  margin-right: auto;
  overflow: hidden;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-caption, 11px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acu-visualizer-surface__card-header :deep(.acu-icon-btn) {
  background: transparent;
}

.acu-visualizer-surface__card-header
  :deep(.acu-icon-btn--default:hover:not(:disabled)) {
  background:
    linear-gradient(var(--acu-hover-overlay), var(--acu-hover-overlay)),
    transparent;
}

.acu-visualizer-surface__card-header :deep(.acu-icon-btn--accent) {
  background: var(--acu-accent-glow);
  color: var(--acu-accent);
}

.acu-visualizer-surface__card-header
  :deep(.acu-icon-btn--danger:hover:not(:disabled)) {
  background: color-mix(in srgb, var(--acu-danger) 12%, transparent);
}

.acu-visualizer-surface__fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.acu-visualizer-surface__field-row {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  align-items: stretch;
}

.acu-visualizer-surface__field-row.is-wide {
  grid-template-columns: minmax(0, 1fr);
}

.acu-visualizer-surface__field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px;
  border: 1px solid transparent;
  border-radius: var(--acu-radius-sm);
  background: transparent;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.acu-visualizer-surface__field :deep(.acu-textarea) {
  flex: 1 1 auto;
}

.acu-visualizer-surface__field-label {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-caption, 11px);
  font-weight: 600;
}

.acu-visualizer-surface__field-label > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acu-visualizer-surface__field-locks {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  opacity: 0.44;
  transition: opacity 0.15s ease;
}

.acu-visualizer-surface__field:hover .acu-visualizer-surface__field-locks,
.acu-visualizer-surface__field:focus-within
  .acu-visualizer-surface__field-locks,
.acu-visualizer-surface__field.is-locked .acu-visualizer-surface__field-locks,
.acu-visualizer-surface__field.is-special-index
  .acu-visualizer-surface__field-locks {
  opacity: 1;
}

.acu-visualizer-surface__field-locks :deep(.acu-icon-btn) {
  width: 24px;
  height: 24px;
  background: transparent;
}

.acu-visualizer-surface__field-locks
  :deep(.acu-icon-btn--default:hover:not(:disabled)) {
  background:
    linear-gradient(var(--acu-hover-overlay), var(--acu-hover-overlay)),
    transparent;
  color: var(--acu-text-1);
}

.acu-visualizer-surface__field-locks :deep(.acu-icon-btn--accent) {
  color: var(--acu-accent);
  background: var(--acu-accent-glow);
}

.acu-visualizer-surface__field.is-locked {
  border-color: var(--acu-border);
  background: color-mix(in srgb, var(--acu-warning) 8%, transparent);
}

.acu-visualizer-surface__footer {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--acu-border-2);
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-body, 12px);
}

.acu-visualizer-surface__footer-actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}

.acu-visualizer-surface__footer-actions :deep(.acu-btn) {
  min-width: 132px;
}

.acu-visualizer-surface__mobile-nav-layer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  inset: 0;
  width: 100%;
  width: 100vw;
  width: 100dvw;
  height: 100%;
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  min-height: 100dvh;
  z-index: 9350;
  display: none;
  align-items: stretch;
  justify-content: flex-start;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.58);
  pointer-events: auto;
  overscroll-behavior: contain;
  animation: visualizer-mobile-nav-layer-in 0.18s ease-out both;
}

.acu-visualizer-surface__mobile-nav-layer.is-closing {
  pointer-events: auto;
  animation: visualizer-mobile-nav-layer-out 0.15s ease-in both;
}

.acu-visualizer-surface__mobile-nav {
  width: 280px;
  max-width: calc(100vw - 72px);
  height: 100%;
  max-height: 100vh;
  min-width: 0;
  min-height: 0;
  align-self: stretch;
  flex: 0 1 280px;
  display: flex;
  flex-direction: column;
  padding: 24px 12px 16px;
  overflow-y: auto;
  border-right: 0;
  background: var(--acu-sidebar-bg);
  box-shadow: var(--acu-shadow);
  pointer-events: auto;
  animation: visualizer-mobile-nav-drawer-in 0.18s ease-out both;
}

.acu-visualizer-surface__mobile-nav-layer.is-closing
  .acu-visualizer-surface__mobile-nav {
  animation: visualizer-mobile-nav-drawer-out 0.15s ease-in both;
}

@supports (width: min(280px, calc(100vw - 72px))) {
  .acu-visualizer-surface__mobile-nav {
    width: min(280px, calc(100vw - 72px));
    flex: 0 0 min(280px, calc(100vw - 72px));
  }
}

@supports (width: 100dvw) {
  .acu-visualizer-surface__mobile-nav {
    max-width: calc(100dvw - 72px);
  }
}

@supports (height: 100dvh) {
  .acu-visualizer-surface__mobile-nav {
    height: 100dvh;
    max-height: 100dvh;
  }
}

.acu-visualizer-surface__dialog-layer {
  position: fixed;
  inset: 0;
  z-index: 9400;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.58);
}

.acu-visualizer-surface__dialog {
  width: min(420px, 100%);
  max-height: calc(100vh - 36px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow: auto;
  border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-md);
  background: var(--acu-bg-1);
  box-shadow: var(--acu-shadow);
}

.acu-visualizer-surface__dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.acu-visualizer-surface__dialog-header h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--acu-text-1);
  font-size: var(--acu-font-size-panel-title, 15px);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acu-visualizer-surface__dialog-message {
  margin: 0;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body-lg, 13px);
  line-height: 1.55;
}

.acu-visualizer-surface__dialog-field {
  display: grid;
  gap: 5px;
}

.acu-visualizer-surface__dialog-field span {
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-caption, 11px);
  font-weight: 600;
}

.acu-visualizer-surface__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.acu-visualizer-surface__dialog-actions--three {
  justify-content: stretch;
}

.acu-visualizer-surface__dialog-actions--three :deep(.acu-btn) {
  flex: 1 1 0;
}

.acu-visualizer-dialog-enter-active,
.acu-visualizer-dialog-leave-active {
  transition: opacity 0.15s ease;
}

.acu-visualizer-dialog-enter-active .acu-visualizer-surface__dialog,
.acu-visualizer-dialog-leave-active .acu-visualizer-surface__dialog {
  transition:
    transform 0.15s ease,
    opacity 0.15s ease;
}

.acu-visualizer-dialog-enter-from,
.acu-visualizer-dialog-leave-to {
  opacity: 0;
}

.acu-visualizer-dialog-enter-from .acu-visualizer-surface__dialog,
.acu-visualizer-dialog-leave-to .acu-visualizer-surface__dialog {
  opacity: 0;
  transform: translateY(6px);
}

@keyframes visualizer-mobile-nav-layer-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes visualizer-mobile-nav-drawer-in {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(0);
  }
}

@keyframes visualizer-mobile-nav-layer-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@keyframes visualizer-mobile-nav-drawer-out {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-100%);
  }
}

@media (max-width: 1024px) {
  .acu-visualizer-surface {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .acu-visualizer-surface__card-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
  }

  .acu-visualizer-surface__topbar {
    flex-wrap: wrap;
  }

  .acu-visualizer-surface__mode-tabs {
    order: 3;
    width: min(420px, 100%);
  }
}

@media (max-width: 767px) {
  .acu-visualizer-surface {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr);
  }

  .acu-visualizer-surface__sidebar {
    display: none;
  }

  .acu-visualizer-surface__topbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    min-height: 0;
    padding: 8px;
  }

  .acu-visualizer-surface__topbar-context {
    grid-column: 1;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .acu-visualizer-surface__mobile-menu {
    display: inline-flex;
  }

  .acu-visualizer-surface__context-items {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .acu-visualizer-surface__context-item:first-child,
  .acu-visualizer-surface__context-item + .acu-visualizer-surface__context-item {
    max-width: none;
  }

  .acu-visualizer-surface__mobile-nav-layer {
    display: flex;
  }

  .acu-visualizer-surface__close {
    grid-column: 2;
    grid-row: 1;
    align-self: center;
  }

  .acu-visualizer-surface__mode-tabs {
    grid-column: 1 / -1;
    width: 100%;
  }

  .acu-visualizer-surface__workspace {
    padding: 10px;
  }

  .acu-visualizer-surface__data-toolbar,
  .acu-visualizer-surface__database-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .acu-visualizer-surface__data-toolbar :deep(.acu-btn),
  .acu-visualizer-surface__database-toolbar :deep(.acu-btn) {
    width: 100%;
  }

  .acu-visualizer-surface__footer {
    display: grid;
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
    align-items: center;
    gap: 8px;
    padding: 8px;
  }

  .acu-visualizer-surface__footer > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acu-visualizer-surface__footer-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }

  .acu-visualizer-surface__footer-actions :deep(.acu-btn) {
    min-width: 0;
    width: 100%;
  }

  .acu-visualizer-surface__dialog {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .acu-visualizer-surface__card-grid {
    grid-template-columns: 1fr;
  }

  .acu-visualizer-surface__fields {
    grid-template-columns: 1fr;
  }

  .acu-visualizer-surface__mode-tabs {
    width: 100%;
  }

  .acu-visualizer-surface__conflict-actions {
    display: flex;
    margin: 8px 0 0;
  }

  .acu-visualizer-surface__footer {
    grid-template-columns: 1fr;
  }

  .acu-visualizer-surface__footer > span {
    display: none;
  }

  .acu-visualizer-surface__dialog-actions,
  .acu-visualizer-surface__dialog-actions--three {
    flex-direction: column;
  }
}
</style>
