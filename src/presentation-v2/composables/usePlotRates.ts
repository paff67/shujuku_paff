/**
 * usePlotRates — 匹配替换字段（D23.5）的字段读写
 *
 * 这些字段是 settings_ACU.plotSettings 顶层（rateMain / ratePersonal / rateErotic /
 * rateCuckold / recallCount），不是 preset-scoped。开发者选项关闭时不渲染。
 */
import { ref } from 'vue';
import { settings_ACU } from '../../service/runtime/state-manager';
import { saveSettings_ACU } from '../../service/settings/settings-service';

export type PlotRateField = 'rateMain' | 'ratePersonal' | 'rateErotic' | 'rateCuckold' | 'recallCount';

export function usePlotRates() {
  const rateMain = ref<number>(1);
  const ratePersonal = ref<number>(1);
  const rateErotic = ref<number>(0);
  const rateCuckold = ref<number>(1);
  const recallCount = ref<number>(20);

  function refresh(): void {
    const plot = (settings_ACU.plotSettings || {}) as Record<string, any>;
    rateMain.value = Number(plot.rateMain ?? 1);
    ratePersonal.value = Number(plot.ratePersonal ?? 1);
    rateErotic.value = Number(plot.rateErotic ?? 0);
    rateCuckold.value = Number(plot.rateCuckold ?? 1);
    recallCount.value = Number(plot.recallCount ?? 20);
  }

  function setRate(field: PlotRateField, value: number): void {
    if (!Number.isFinite(value)) return;
    const plot = (settings_ACU.plotSettings || {}) as Record<string, any>;
    plot[field] = value;
    if (field === 'rateMain') rateMain.value = value;
    else if (field === 'ratePersonal') ratePersonal.value = value;
    else if (field === 'rateErotic') rateErotic.value = value;
    else if (field === 'rateCuckold') rateCuckold.value = value;
    else recallCount.value = value;
    saveSettings_ACU();
  }

  return {
    rateMain,
    ratePersonal,
    rateErotic,
    rateCuckold,
    recallCount,
    refresh,
    setRate,
  };
}
