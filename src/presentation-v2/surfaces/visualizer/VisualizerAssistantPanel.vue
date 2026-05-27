<template>
  <div class="acu-viz-assistant" data-acu-visualizer-assistant>
    <AcuPanel
      title="AI 改表助手"
      description="用自然语言让助手生成改表草稿。它可能改多张表或全局配置；应用前先检查变更，不满意就改写需求重来。"
    >
      <template #actions>
        <AcuBadge v-if="assistant.isRunning.value" variant="warning">运行中</AcuBadge>
        <AcuBadge v-else-if="assistant.latestResult.value" variant="accent">有草稿</AcuBadge>
        <AcuBadge v-else variant="neutral">待输入</AcuBadge>
      </template>

      <div class="acu-viz-assistant__controls">
        <AcuFormRow label="API 预设">
          <AcuSelect
            :model-value="assistant.tableApiPreset.value"
            :options="assistant.apiPresetOptions.value"
            :disabled="assistant.isRunning.value"
            @update:model-value="value => assistant.tableApiPreset.value = value"
          />
        </AcuFormRow>
        <AcuFormRow label="最大轮次">
          <AcuInput
            type="number"
            :model-value="assistant.maxRounds.value"
            :min="1"
            :max="6"
            :step="1"
            :disabled="assistant.isRunning.value"
            @update:model-value="updateMaxRounds"
          />
        </AcuFormRow>
      </div>

      <AcuFormRow label="改表需求">
        <AcuTextarea
          :model-value="assistant.userRequest.value"
          :rows="4"
          :disabled="assistant.isRunning.value"
          placeholder="例如：给当前角色状态表新增“短期目标”和“风险提示”两列，并把世界书条目改成更适合长期记忆的说明。"
          @update:model-value="value => assistant.userRequest.value = value"
        />
      </AcuFormRow>

      <div class="acu-viz-assistant__action-row">
        <AcuButton
          v-if="assistant.isRunning.value"
          variant="danger"
          @click="assistant.cancel"
        >
          <i class="fa-solid fa-stop"></i>
          停止会话
        </AcuButton>
        <AcuButton
          v-else
          variant="primary"
          :disabled="!assistant.userRequest.value.trim()"
          @click="assistant.run"
        >
          <i class="fa-solid fa-wand-magic-sparkles"></i>
          生成改表草稿
        </AcuButton>
        <AcuButton
          :disabled="!assistant.canApply.value"
          @click="assistant.applyLatestDraft"
        >
          应用到编辑器草稿
        </AcuButton>
      </div>

      <AcuInfoBanner v-if="assistant.errorMessage.value" tone="warning">
        {{ assistant.errorMessage.value }}
      </AcuInfoBanner>
    </AcuPanel>

    <AcuDisclosureGroup
      label="会话过程"
      :expanded="transcriptExpanded"
      body-id="acu-viz-assistant-transcript"
      body-mode="show"
      body-max-height="min(72vh, 680px)"
      root-class="acu-viz-assistant__disclosure"
      body-class="acu-viz-assistant__disclosure-body"
      @toggle="transcriptExpanded = !transcriptExpanded"
    >
      <template #meta>
        {{ assistant.turns.value.length || assistant.rounds.value.length }} 条
      </template>

      <AcuPanel
        class="acu-viz-assistant__folded-panel"
        title="会话过程"
        description="用于查看 AI 每轮做了什么。正常只看最终草稿；结果奇怪或报错时再展开排查。"
      >
        <div v-if="assistant.isRunning.value" class="acu-viz-assistant__running">
          <i class="fa-solid fa-spinner fa-spin"></i>
          <span>正在生成草稿，已完成 {{ assistant.rounds.value.length }} 轮。</span>
        </div>

        <p v-if="!assistant.turns.value.length && !assistant.rounds.value.length" class="acu-viz-assistant__empty">
          还没有会话。输入需求后，助手会返回摘要、警告、分组 diff 和需要确认的风险项。
        </p>

        <div class="acu-viz-assistant__turns">
          <article
            v-for="turn in assistant.turns.value"
            :key="turn.id"
            class="acu-viz-assistant__turn"
            :class="`acu-viz-assistant__turn--${turn.type}`"
          >
            <header class="acu-viz-assistant__turn-head">
              <strong v-if="turn.type === 'user'">你提出的需求</strong>
              <strong v-else-if="turn.type === 'round'">AI 助手 · 第 {{ turn.round }} / {{ turn.maxRounds }} 轮</strong>
              <strong v-else-if="turn.type === 'final'">AI 助手 · 最终草稿</strong>
              <strong v-else>执行错误</strong>
              <AcuBadge v-if="turn.type === 'final'" variant="accent">
                {{ turn.result.session.roundsExecuted }} 轮
              </AcuBadge>
              <AcuBadge v-else-if="turn.type === 'round'" variant="neutral">过程记录</AcuBadge>
              <AcuBadge v-else-if="turn.type === 'error'" variant="warning">需要处理</AcuBadge>
              <AcuBadge v-else variant="neutral">请求</AcuBadge>
            </header>
            <p>{{ assistant.getTurnSummary(turn) }}</p>

            <AcuInfoBanner
              v-if="assistant.getTurnWarnings(turn).length"
              tone="warning"
            >
              <ul class="acu-viz-assistant__inline-list">
                <li
                  v-for="warning in assistant.getTurnWarnings(turn)"
                  :key="warning"
                >
                  {{ warning }}
                </li>
              </ul>
            </AcuInfoBanner>

            <div
              v-if="assistant.getTurnDiffGroups(turn).length"
              class="acu-viz-assistant__turn-diff"
            >
              <section
                v-for="group in assistant.getTurnDiffGroups(turn)"
                :key="`${turn.id}-${group.key}`"
                class="acu-viz-assistant__diff-group"
                :class="{ 'acu-viz-assistant__diff-group--warning': group.tone === 'warning' }"
              >
                <h4>{{ group.title }}</h4>
                <ul>
                  <li v-for="item in group.items" :key="item">{{ item }}</li>
                </ul>
              </section>
            </div>
          </article>
        </div>
      </AcuPanel>
    </AcuDisclosureGroup>

    <AcuDisclosureGroup
      v-if="assistant.latestResult.value"
      label="草稿检查"
      :expanded="draftExpanded"
      body-id="acu-viz-assistant-draft"
      body-mode="show"
      body-max-height="min(72vh, 680px)"
      root-class="acu-viz-assistant__disclosure"
      body-class="acu-viz-assistant__disclosure-body"
      @toggle="draftExpanded = !draftExpanded"
    >
      <template #meta>
        {{ assistant.highRiskItems.value.length ? `高风险 ${assistant.highRiskItems.value.length} 项` : '可检查' }}
      </template>

      <AcuPanel
        class="acu-viz-assistant__folded-panel"
        title="草稿检查"
        description="应用前检查每组变更。涉及删表、跨表、排序、锁、全局配置等高风险项时，需要逐项确认。"
      >
        <div class="acu-viz-assistant__summary">
          <AcuBadge variant="neutral">{{ assistant.sessionSummary.value || '会话完成' }}</AcuBadge>
          <AcuBadge v-if="assistant.highRiskItems.value.length" variant="warning">
            高风险 {{ assistant.highRiskItems.value.length }} 项
          </AcuBadge>
          <AcuBadge v-else variant="accent">无高风险项</AcuBadge>
        </div>

        <AcuInfoBanner
          v-if="assistant.latestResult.value.draft.warnings.length"
          tone="warning"
        >
          <ul class="acu-viz-assistant__inline-list">
            <li
              v-for="warning in assistant.latestResult.value.draft.warnings"
              :key="warning"
            >
              {{ warning }}
            </li>
          </ul>
        </AcuInfoBanner>

        <div v-if="assistant.diffGroups.value.length" class="acu-viz-assistant__diff-grid">
          <section
            v-for="group in assistant.diffGroups.value"
            :key="group.key"
            class="acu-viz-assistant__diff-group"
            :class="{ 'acu-viz-assistant__diff-group--warning': group.tone === 'warning' }"
          >
            <h4>{{ group.title }}</h4>
            <ul>
              <li v-for="item in group.items" :key="item">{{ item }}</li>
            </ul>
          </section>
        </div>
        <p v-else class="acu-viz-assistant__empty">
          草稿没有声明具体变更。通常表示助手认为需求不够明确，或本次无需修改。
        </p>

        <div class="acu-viz-assistant__risk-list">
          <h4>高风险确认</h4>
          <p v-if="!assistant.highRiskItems.value.length" class="acu-viz-assistant__empty">
            没有需要额外确认的高风险操作。
          </p>
          <article
            v-for="(item, index) in assistant.highRiskItems.value"
            :key="`${item.type}-${index}`"
            class="acu-viz-assistant__risk-item"
          >
            <AcuCheckbox
              :model-value="assistant.riskConfirmations.value[String(index)] === true"
              @update:model-value="value => assistant.setRiskConfirmation(index, value)"
            >
              {{ item.label }}
            </AcuCheckbox>
          </article>
        </div>
      </AcuPanel>
    </AcuDisclosureGroup>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import AcuBadge from '../../components/_lib/AcuBadge.vue';
import AcuButton from '../../components/_lib/AcuButton.vue';
import AcuCheckbox from '../../components/_lib/AcuCheckbox.vue';
import AcuDisclosureGroup from '../../components/_lib/AcuDisclosureGroup.vue';
import AcuFormRow from '../../components/_lib/AcuFormRow.vue';
import AcuInfoBanner from '../../components/_lib/AcuInfoBanner.vue';
import AcuInput from '../../components/_lib/AcuInput.vue';
import AcuPanel from '../../components/_lib/AcuPanel.vue';
import AcuSelect from '../../components/_lib/AcuSelect.vue';
import AcuTextarea from '../../components/_lib/AcuTextarea.vue';
import { useVisualizerAssistant } from '../../composables/visualizer/useVisualizerAssistant';

const assistant = useVisualizerAssistant();
const transcriptExpanded = ref(true);
const draftExpanded = ref(true);

function updateMaxRounds(value: string | number): void {
  const next = Math.max(1, Math.min(6, Math.floor(Number(value) || 1)));
  assistant.maxRounds.value = next;
}

watch(() => assistant.latestResult.value, value => {
  if (value) draftExpanded.value = true;
});
</script>

<style scoped>
.acu-viz-assistant {
  min-width: 0;
  display: grid;
  gap: 12px;
}

.acu-viz-assistant__controls {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(140px, 180px);
  gap: 10px;
}

.acu-viz-assistant__disclosure {
  min-width: 0;
  border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-md);
  background: var(--acu-bg-1);
}

.acu-viz-assistant__disclosure :deep(.acu-disclosure-group__header) {
  min-height: 38px;
  padding: 8px 12px;
}

:deep(.acu-viz-assistant__disclosure-body) {
  padding: 0;
}

.acu-viz-assistant__folded-panel {
  border: 0;
  border-radius: 0;
}

.acu-viz-assistant__action-row,
.acu-viz-assistant__summary,
.acu-viz-assistant__running,
.acu-viz-assistant__turn-head {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.acu-viz-assistant__action-row,
.acu-viz-assistant__summary {
  flex-wrap: wrap;
}

.acu-viz-assistant__running {
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body-lg, 13px);
}

.acu-viz-assistant__empty {
  margin: 0;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body-lg, 13px);
  line-height: 1.55;
}

.acu-viz-assistant__turns,
.acu-viz-assistant__risk-list {
  min-width: 0;
  display: grid;
  gap: 8px;
}

.acu-viz-assistant__turn,
.acu-viz-assistant__risk-item,
.acu-viz-assistant__diff-group {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-sm);
  background: var(--acu-bg-0);
}

.acu-viz-assistant__turn strong,
.acu-viz-assistant__diff-group h4,
.acu-viz-assistant__risk-list h4 {
  min-width: 0;
  margin: 0;
  color: var(--acu-text-1);
  font-size: var(--acu-font-size-body-lg, 13px);
  line-height: 1.35;
}

.acu-viz-assistant__turn {
  display: grid;
  gap: 6px;
}

.acu-viz-assistant__turn--user {
  box-shadow: inset 3px 0 0 var(--acu-accent);
}

.acu-viz-assistant__turn--round {
  background: var(--acu-bg-1);
}

.acu-viz-assistant__turn--error {
  box-shadow: inset 3px 0 0 var(--acu-warning);
}

.acu-viz-assistant__turn-head {
  justify-content: space-between;
}

.acu-viz-assistant__turn-head strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acu-viz-assistant__turn p {
  margin: 0;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body, 12px);
  line-height: 1.55;
}

.acu-viz-assistant__diff-grid {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.acu-viz-assistant__turn-diff {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.acu-viz-assistant__diff-group {
  display: grid;
  gap: 8px;
}

.acu-viz-assistant__diff-group--warning {
  box-shadow: inset 3px 0 0 var(--acu-warning);
}

.acu-viz-assistant__diff-group ul,
.acu-viz-assistant__inline-list {
  margin: 0;
  padding-left: 18px;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body, 12px);
  line-height: 1.55;
}

.acu-viz-assistant__risk-list {
  padding-top: 10px;
  border-top: 1px solid var(--acu-border-2);
}

@media (max-width: 860px) {
  .acu-viz-assistant__controls,
  .acu-viz-assistant__diff-grid {
    grid-template-columns: 1fr;
  }

  :deep(.acu-viz-assistant__disclosure-body) {
    max-height: min(68vh, 620px);
    overflow-y: auto;
  }
}

@media (max-width: 767px) {
  .acu-viz-assistant__action-row {
    align-items: stretch;
    flex-direction: column;
  }

  .acu-viz-assistant__action-row :deep(.acu-btn) {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .acu-viz-assistant__turn-head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
