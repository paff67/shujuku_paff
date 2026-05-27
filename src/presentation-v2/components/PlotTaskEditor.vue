<template>
  <div v-if="task" class="acu-v2-plot-task-editor">
    <fieldset class="acu-v2-plot-task-editor__section">
      <legend>基本字段</legend>
      <div class="acu-v2-plot-task-editor__grid">
        <AcuFormRow label="任务名称">
          <AcuInput
            type="text"
            :model-value="task.name"
            placeholder="例如：记忆召回任务"
            @change="patch({ name: String($event) })"
          />
        </AcuFormRow>
        <AcuFormRow label="阶段号" hint="同阶段并发，跨阶段串行">
          <AcuInput
            type="number"
            :min="1"
            :step="1"
            :model-value="task.stage"
            @change="patch({ stage: Math.max(1, Math.round(Number($event))) })"
          />
        </AcuFormRow>
        <AcuFormRow label="最大重试">
          <AcuInput
            type="number"
            :min="1"
            :step="1"
            :model-value="task.maxRetries"
            @change="
              patch({ maxRetries: Math.max(1, Math.round(Number($event))) })
            "
          />
        </AcuFormRow>
        <AcuFormRow label="启用任务">
          <AcuToggle
            :model-value="task.enabled"
            :label="task.enabled ? '已启用' : '已禁用'"
            @update:model-value="patch({ enabled: $event })"
          />
        </AcuFormRow>
      </div>
      <div class="acu-v2-plot-task-editor__grid">
        <AcuFormRow
          label="标签摘取"
          hint="例如 recall,supplement，仅作用于本任务"
        >
          <AcuInput
            type="text"
            :model-value="task.extractTags"
            @change="patch({ extractTags: String($event) })"
          />
        </AcuFormRow>
        <AcuFormRow label="提取写入标签" hint="优先级高于标签摘取；留空不追加">
          <AcuInput
            type="text"
            :model-value="task.extractInjectTags"
            @change="patch({ extractInjectTags: String($event) })"
          />
        </AcuFormRow>
        <AcuFormRow label="最小回复长度" hint="少于此长度自动重试">
          <AcuInput
            type="number"
            :min="0"
            :step="10"
            :model-value="task.minLength"
            @change="
              patch({ minLength: Math.max(0, Math.round(Number($event))) })
            "
          />
        </AcuFormRow>
      </div>
    </fieldset>

    <fieldset class="acu-v2-plot-task-editor__section">
      <legend>当前任务使用的 API</legend>
      <AcuFormRow
        label="API 预设"
        hint="单独为当前任务选择API预设，默认继承剧情推进页。优先级：任务 > 剧情推进页 > 活动 API。全局保存，不写入预设。"
      >
        <AcuSelect
          :options="taskApiSelectOptions"
          :model-value="taskApiOverride"
          placeholder="继承剧情推进 API 预设"
          @update:model-value="$emit('task-api-override', $event)"
        />
      </AcuFormRow>
    </fieldset>

    <PlotMatchReplaceFields
      v-if="showAdvancedRates"
      :rate-main="rates.rateMain"
      :rate-personal="rates.ratePersonal"
      :rate-erotic="rates.rateErotic"
      :rate-cuckold="rates.rateCuckold"
      :recall-count="rates.recallCount"
      @update-rate="(field, value) => $emit('update-rate', field, value)"
    />

    <fieldset class="acu-v2-plot-task-editor__section">
      <legend>提示词段（promptGroup）</legend>
      <PlotPromptSegments
        :segments="task.promptGroup"
        @add="$emit('segment-add', $event)"
        @delete="$emit('segment-delete', $event)"
        @move="(index, delta) => $emit('segment-move', index, delta)"
        @update="(index, patch) => $emit('segment-update', index, patch)"
      />
    </fieldset>
  </div>
  <div v-else class="acu-v2-plot-task-editor__empty">
    请在上方选择一个任务进行编辑。
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { PlotRateField } from "../composables/usePlotRates";
import type {
  PlotPromptSegment,
  PlotTaskDraft,
} from "../composables/usePlotTaskEditing";
import AcuFormRow from "./_lib/AcuFormRow.vue";
import AcuInput from "./_lib/AcuInput.vue";
import type { AcuSelectOption } from "./_lib/AcuSelect.vue";
import AcuSelect from "./_lib/AcuSelect.vue";
import AcuToggle from "./_lib/AcuToggle.vue";
import PlotMatchReplaceFields from "./PlotMatchReplaceFields.vue";
import PlotPromptSegments from "./PlotPromptSegments.vue";

const props = defineProps<{
  task: PlotTaskDraft | null;
  apiPresetOptions: Array<{ name: string }>;
  taskApiOverride: string;
  showAdvancedRates: boolean;
  rates: {
    rateMain: number;
    ratePersonal: number;
    rateErotic: number;
    rateCuckold: number;
    recallCount: number;
  };
}>();

const emit = defineEmits<{
  (e: "patch", patch: Partial<PlotTaskDraft>): void;
  (e: "task-api-override", value: string): void;
  (e: "update-rate", field: PlotRateField, value: number): void;
  (e: "segment-add", position: "top" | "bottom"): void;
  (e: "segment-delete", index: number): void;
  (e: "segment-move", index: number, delta: -1 | 1): void;
  (e: "segment-update", index: number, patch: Partial<PlotPromptSegment>): void;
}>();

const taskApiSelectOptions = computed<AcuSelectOption[]>(() => [
  { value: "", label: "继承剧情推进 API 预设" },
  ...props.apiPresetOptions.map((o) => ({ value: o.name, label: o.name })),
]);

function patch(value: Partial<PlotTaskDraft>): void {
  emit("patch", value);
}
</script>

<style scoped>
.acu-v2-plot-task-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.acu-v2-plot-task-editor__section {
  margin: 0;
  padding: 0 0 14px;
  border: 0;
  border-bottom: 1px solid
    color-mix(in srgb, var(--acu-text-3) 16%, transparent);
  border-radius: 0;
  background: transparent;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.acu-v2-plot-task-editor__section:last-of-type {
  padding-bottom: 0;
  border-bottom: 0;
}
.acu-v2-plot-task-editor__section legend {
  padding: 0;
  font-size: var(--acu-font-size-section-title, 12px);
  font-weight: 600;
  color: var(--acu-text-2);
}

.acu-v2-plot-task-editor__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.acu-v2-plot-task-editor__hint {
  margin: 0;
  font-size: var(--acu-font-size-caption, 11px);
  color: var(--acu-text-3);
  line-height: var(--acu-line-height-caption, 1.5);
}

.acu-v2-plot-task-editor__empty {
  padding: 18px 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--acu-text-3) 14%, transparent);
  border-bottom: 1px solid
    color-mix(in srgb, var(--acu-text-3) 14%, transparent);
  border-radius: 0;
  background: transparent;
  text-align: center;
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-body, 12px);
}
</style>
