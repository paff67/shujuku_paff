<template>
  <section class="acu-v2-continuation-page">
    <AcuPanelGrid class="acu-v2-continuation-page__grid">
      <AcuPanel
        :title="continuationCopy.panels.conditions.title"
        :description="continuationCopy.panels.conditions.description"
      >
        <AcuFormRow
          label="标签检查"
          hint="检查回复中是否出现指定标签文本，缺一项自动重试。多个标签逗号分隔，留空不检查。"
        >
          <AcuInput
            :model-value="store.loopTags"
            type="text"
            placeholder="例如: content, thinking"
            @update:model-value="store.setLoopTags(String($event))"
          />
        </AcuFormRow>

        <div class="acu-v2-continuation-page__number-grid">
          <AcuFormRow
            label="循环延时"
            hint="单位秒数，每次成功续写后等待时间。"
          >
            <AcuInput
              :model-value="store.loopDelay"
              type="number"
              :min="0"
              :step="1"
              @change="store.setLoopDelay($event)"
            />
          </AcuFormRow>
          <AcuFormRow label="总时长" hint="单位分钟，须大于0。">
            <AcuInput
              :model-value="store.loopTotalDuration"
              type="number"
              :min="0"
              :step="1"
              @change="store.setLoopTotalDuration($event)"
            />
          </AcuFormRow>
          <AcuFormRow label="失败上限" hint="失败时重试次数上限。">
            <AcuInput
              :model-value="store.maxRetries"
              type="number"
              :min="0"
              :step="1"
              @change="store.setMaxRetries($event)"
            />
          </AcuFormRow>
          <AcuFormRow
            label="AI 上下文"
            hint="仅统计AI最新N个楼层回复，不统计用户输入。"
          >
            <AcuInput
              :model-value="store.contextTurnCount"
              type="number"
              :min="0"
              :max="20"
              :step="1"
              @change="store.setContextTurnCount($event)"
            />
          </AcuFormRow>
        </div>
      </AcuPanel>

      <div class="acu-v2-continuation-page__side-stack">
        <AcuPanel
          :title="continuationCopy.panels.prompts.title"
          :description="continuationCopy.panels.prompts.description"
        >
          <div class="acu-v2-continuation-page__prompt-toolbar">
            <span class="acu-v2-continuation-page__meta">{{
              store.promptCount ? `${store.promptCount} 条提示词` : "暂无提示词"
            }}</span>
            <AcuButton size="sm" @click="store.addPrompt">
              <i class="fa-solid fa-plus"></i>
              添加提示词
            </AcuButton>
          </div>

          <div
            v-if="store.prompts.length"
            class="acu-v2-continuation-page__prompt-list"
          >
            <div
              v-for="(prompt, index) in store.prompts"
              :key="index"
              class="acu-v2-continuation-page__prompt-item"
            >
              <div class="acu-v2-continuation-page__prompt-head">
                <span>提示词 {{ index + 1 }}</span>
                <AcuIconButton
                  icon="fa-solid fa-trash-can"
                  variant="danger"
                  size="sm"
                  title="删除此提示词"
                  @click="store.removePrompt(index)"
                />
              </div>
              <AcuTextarea
                :model-value="prompt"
                :rows="4"
                placeholder="输入本轮要发送给主 AI 的续写提示..."
                @update:model-value="store.setPrompt(index, $event)"
              />
            </div>
          </div>
          <p v-else class="acu-v2-continuation-page__empty">
            请先添加一条内容，再启动智能续写。
          </p>
        </AcuPanel>

        <AcuPanel
          :title="continuationCopy.panels.controls.title"
          :description="continuationCopy.panels.controls.description"
        >
          <div class="acu-v2-continuation-page__status">
            <span class="acu-v2-continuation-page__status-label">循环状态</span>
            <strong :class="{ 'is-running': loop.running.value }">{{
              loop.statusText.value
            }}</strong>
            <span
              v-if="loop.timerText.value"
              class="acu-v2-continuation-page__timer"
              >剩余 {{ loop.timerText.value }}</span
            >
          </div>

          <div class="acu-v2-continuation-page__actions">
            <AcuButton
              v-if="!loop.running.value"
              variant="primary"
              :disabled="!store.hasPrompt || store.loopTotalDuration <= 0"
              @click="loop.start"
            >
              <i class="fa-solid fa-play"></i>
              开始智能续写
            </AcuButton>
            <AcuButton v-else variant="danger" @click="loop.stop">
              <i class="fa-solid fa-stop"></i>
              停止智能续写
            </AcuButton>
          </div>
        </AcuPanel>
      </div>
    </AcuPanelGrid>
  </section>
</template>

<script setup lang="ts">
import { onMounted, watch } from "vue";
import AcuButton from "../components/_lib/AcuButton.vue";
import AcuFormRow from "../components/_lib/AcuFormRow.vue";
import AcuIconButton from "../components/_lib/AcuIconButton.vue";
import AcuInput from "../components/_lib/AcuInput.vue";
import AcuPanel from "../components/_lib/AcuPanel.vue";
import AcuPanelGrid from "../components/_lib/AcuPanelGrid.vue";
import AcuTextarea from "../components/_lib/AcuTextarea.vue";
import { useChatChangedTick } from "../composables/useChatChangedListener";
import { useContinuationLoop } from "../composables/useContinuationLoop";
import { continuationCopy } from "../copy/continuation-copy";
import { useContinuationStore } from "../stores/continuation-store";

const store = useContinuationStore();
const loop = useContinuationLoop();

function refreshAll(): void {
  store.refreshFromSettings();
  loop.refreshStatus();
}

onMounted(refreshAll);
watch(useChatChangedTick(), refreshAll);
</script>

<style scoped>
.acu-v2-continuation-page {
  min-height: 100%;
  min-width: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.acu-v2-continuation-page__side-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.acu-v2-continuation-page__prompt-toolbar,
.acu-v2-continuation-page__prompt-head,
.acu-v2-continuation-page__actions,
.acu-v2-continuation-page__status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.acu-v2-continuation-page__prompt-toolbar {
  justify-content: space-between;
}

.acu-v2-continuation-page__meta,
.acu-v2-continuation-page__empty,
.acu-v2-continuation-page__timer {
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-caption, 11px);
}

.acu-v2-continuation-page__empty {
  margin: 0;
  padding: 10px 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--acu-text-3) 14%, transparent);
  border-bottom: 1px solid
    color-mix(in srgb, var(--acu-text-3) 14%, transparent);
  border-radius: 0;
  background: transparent;
}

.acu-v2-continuation-page__prompt-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.acu-v2-continuation-page__prompt-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 0 12px;
  border: 0;
  border-bottom: 1px solid
    color-mix(in srgb, var(--acu-text-3) 16%, transparent);
  border-radius: 0;
  background: transparent;
}

.acu-v2-continuation-page__prompt-item:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.acu-v2-continuation-page__prompt-head {
  justify-content: space-between;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body, 12px);
  font-weight: 500;
}

.acu-v2-continuation-page__number-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.acu-v2-continuation-page__status {
  min-height: 38px;
  padding: 8px 0 8px 10px;
  border: 0;
  border-left: 2px solid color-mix(in srgb, var(--acu-text-3) 28%, transparent);
  border-radius: 0;
  background: transparent;
}

.acu-v2-continuation-page__status-label {
  color: var(--acu-text-3);
  font-size: var(--acu-font-size-caption, 11px);
}

.acu-v2-continuation-page__status strong {
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-body-lg, 13px);
}

.acu-v2-continuation-page__status strong.is-running {
  color: var(--acu-success);
}

.acu-v2-continuation-page__actions {
  justify-content: flex-end;
  padding-top: 12px;
  margin-top: 4px;
}

@media (max-width: 860px) {
  .acu-v2-continuation-page {
    padding: 14px;
  }

  .acu-v2-continuation-page__number-grid {
    grid-template-columns: 1fr;
  }
}
</style>
