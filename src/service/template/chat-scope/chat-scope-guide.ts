/**
 * service/template/chat-scope/chat-scope-guide.ts
 * Sheet Guide 数据操作（D 组）
 */
import { DEFAULT_TABLE_TEMPLATE_ACU, TABLE_TEMPLATE_ACU, _set_TABLE_TEMPLATE_ACU} from '../../../shared/defaults-json.js';
import { readProfileTemplateFromStorage_ACU, saveCurrentProfileTemplate_ACU } from '../../../data/repositories/profile-repo';
import { DEFAULT_TEMPLATE_PRESET_OPTION_VALUE_ACU, deriveTemplatePresetNameForImport_ACU, getCurrentTemplatePresetName_ACU, normalizeTemplatePresetSelectionValue_ACU } from '../../../shared/template-preset-utils';
import { CHAT_SCOPED_CONFIG_FIELD_ACU, CHAT_SHEET_GUIDE_FIELD_ACU, CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU, CHAT_SHEET_GUIDE_VERSION_ACU, CHAT_TEMPLATE_ARCHIVE_OPTION_PREFIX_ACU, LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU, MAX_CHAT_TEMPLATE_ARCHIVES_PER_TAG_ACU, getChatScopedConfigContainer_ACU, getChatSheetGuideContainer_ACU, normalizeChatScopedConfigContainer_ACU } from '../../../data/storage/chat-history';
import { getDefaultTemplateSnapshot_ACU, getTemplatePreset_ACU } from '../template-preset-service';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU } from '../../runtime/state-manager';
import { parseDDLColumnComments, parseDDLColumnNames } from '../../../shared/ddl-utils';
import { getChatArray_ACU, saveChatToHost_ACU } from '../../../data/gateways/chat-gateway';
import { TABLE_ORDER_FIELD_ACU } from '../../../shared/constants';
import { applyTemplateScopeForCurrentChat_ACU } from '../../settings/settings-service';
import { refreshMergedDataAndNotify_ACU } from '../../worldbook/pipeline';
import { safeJsonParse_ACU, safeJsonStringify_ACU } from '../../../shared/json-helpers';
import { applySheetOrderNumbers_ACU, cloneScopedConfigData_ACU, ensureSheetOrderNumbers_ACU, getChatFirstLayerMessage_ACU, hashUserInput_ACU, isSummaryOrOutlineTable_ACU, logDebug_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../../shared/utils';

import { getTemplatePresetDisplayName_ACU, persistTemplateScopeSelectionState_ACU, upsertTemplatePreset_ACU } from '../template-preset-service';
import { formatPlotScopeUpdatedAt_ACU } from '../../../shared/utils';
import { ensureExportConfigDefaults_ACU, ensureGlobalInjectionConfigDefaults_ACU } from '../../worldbook/injection-engine';
import { isLegacyMatchForIsolation_ACU, readIsolatedTagData_ACU, readLegacyIndependentData_ACU, readLegacyStandardData_ACU } from '../../../data/repositories/chat-message-data-repo';
import { normalizeChatScopedConfigSource_ACU, normalizeGuideData_ACU } from './chat-scope-base';
// 循环 import — 运行时安全
import { normalizeTemplateScopeMode_ACU, normalizeTemplateScopeIsolationKey_ACU, sanitizeTemplateSnapshotForChat_ACU, getCurrentChatTemplateScopeState_ACU, setCurrentChatTemplateScopeState_ACU, buildChatTemplateScopeStateFromCurrent_ACU, getGlobalTemplateSnapshotForCurrentProfile_ACU, upsertChatTemplatePresetEntry_ACU, normalizeChatTemplateScopeState_ACU } from './chat-scope-template';
import { getSortedSheetKeys_ACU } from './chat-scope-sheet';

  export function materializeDataFromSheetGuide_ACU(guideData: Record<string, any> | null, { includeSeedRows = true } = {}) {
      const normalized = normalizeGuideData_ACU(guideData);
      if (!normalized) return { mate: { type: 'chatSheets', version: 1 } };
      const out: Record<string, any> = { mate: normalized.mate || { type: 'chatSheets', version: 1 } };
      Object.keys(normalized).forEach((k: string) => {
          if (!k.startsWith('sheet_')) return;
          const s = normalized[k];
          let headerRow = Array.isArray(s?.content?.[0]) ? JSON.parse(JSON.stringify(s.content[0])) : null;
          // [防御] 表头为空数组或全空时，从 DDL 推导列名和中文注释
          if (!headerRow || headerRow.length === 0 || headerRow.every((v: any) => v === null || v === undefined || String(v ?? '').trim() === '')) {
              const ddl = s?.sourceData?.ddl;
              if (ddl && typeof ddl === 'string') {
                  try {
                      const comments = parseDDLColumnComments(ddl);
                      headerRow = parseDDLColumnNames(ddl).map(sqlName => comments.get(sqlName) || sqlName);
                  } catch (_) { headerRow = null; }
              }
          }
          if (!headerRow || headerRow.length === 0) headerRow = ['row_id'];
          const next = JSON.parse(JSON.stringify(s));
          // content: header + (可选) seedRows
          const seedRows = includeSeedRows && Array.isArray(s?.[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU])
              ? JSON.parse(JSON.stringify(s[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU]))
              : [];
          next.content = [headerRow, ...seedRows];
          // 保留 seedRows 字段本身（便于后续再次写回/二次处理），但不会影响表格使用者（他们只看 content）
          out[k] = next;
      });
      return out;
  }

  function getLegacyHeaderGuideDataForIsolationKey_ACU({ chat = getChatArray_ACU(), isolationKey = getCurrentIsolationKey_ACU() } = {}) {
      const normalizedKey = String(isolationKey ?? '');
      try {
          const first = getChatFirstLayerMessage_ACU(chat);
          const legacyRaw = first ? first[LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU] : null;
          const legacyObj = legacyRaw ? ((typeof legacyRaw === 'string') ? safeJsonParse_ACU(legacyRaw, null) : legacyRaw) : null;
          const legacyTags = legacyObj?.tags;
          const legacySlot = (legacyTags && typeof legacyTags === 'object') ? legacyTags[normalizedKey] : null;
          const legacyHeaders = Array.isArray(legacySlot?.headers) ? legacySlot.headers : null;
          if (!legacyHeaders || legacyHeaders.length === 0) return null;

          const orderedUids = legacyHeaders
              .map((h: any) => h?.uid)
              .filter((uid: any) => typeof uid === 'string' && uid.startsWith('sheet_'));
          if (orderedUids.length === 0) return null;

          const templateObj = parseTableTemplateJson_ACU({ stripSeedRows: false });
          const out: any = { mate: { type: 'chatSheets', version: CHAT_SHEET_GUIDE_VERSION_ACU } };
          orderedUids.forEach((uid: string, idx: number) => {
              const base = (templateObj && templateObj[uid])
                  ? JSON.parse(JSON.stringify(templateObj[uid]))
                  : { uid, name: uid, content: [["row_id"]], sourceData: {}, updateConfig: {}, exportConfig: {} };
              if (Array.isArray(base.content) && base.content.length > 1) {
                  base[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU] = JSON.parse(JSON.stringify(base.content.slice(1)));
                  base.content = [base.content[0]];
              }
              if (!Array.isArray(base.content) || base.content.length === 0) base.content = [["row_id"]];
              base.uid = uid;
              if (!Number.isFinite(base[TABLE_ORDER_FIELD_ACU])) base[TABLE_ORDER_FIELD_ACU] = idx;
              out[uid] = base;
          });
          return normalizeGuideData_ACU(out);
      } catch (e) {
          return null;
      }
  }

  function getHistoricalTemplateGuideDataForIsolationKey_ACU({ chat = getChatArray_ACU(), isolationKey = getCurrentIsolationKey_ACU() } = {}) {
      const normalizedKey = normalizeTemplateScopeIsolationKey_ACU(isolationKey);
      if (!Array.isArray(chat) || chat.length === 0) return null;

      const historicalData: Record<string, any> = { mate: { type: 'chatSheets', version: 1 } };
      const encounteredKeys: string[] = [];
      const encounteredSet = new Set();
      const hasSheetTables = (dataObj: Record<string, any> | null | undefined) => (
          !!dataObj
          && typeof dataObj === 'object'
          && Object.keys(dataObj).some(key => key.startsWith('sheet_'))
      );
      const appendTables = (dataObj: Record<string, any> | null, { summaryOnly = null as boolean | null } = {}) => {
          if (!dataObj || typeof dataObj !== 'object' || Array.isArray(dataObj)) return;
          Object.keys(dataObj).forEach(key => {
              if (!key.startsWith('sheet_') || encounteredSet.has(key)) return;
              const sheet = dataObj[key];
              if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return;
              const isSummary = !!sheet.name && isSummaryOrOutlineTable_ACU(sheet.name);
              if (summaryOnly === true && !isSummary) return;
              if (summaryOnly === false && isSummary) return;
              historicalData[key] = JSON.parse(JSON.stringify(sheet));
              encounteredKeys.push(key);
              encounteredSet.add(key);
          });
      };

      for (let i = chat.length - 1; i >= 0; i--) {
          const message = chat[i];
          if (!message || message.is_user) continue;
          const isolationConfig = {
              enabled: !!settings_ACU?.dataIsolationEnabled,
              code: String(settings_ACU?.dataIsolationCode || ''),
          };

          // ── 优先读取 V2 隔离数据 ──
          const tagData = readIsolatedTagData_ACU(message, normalizedKey);
          const hasV2IndependentTables = hasSheetTables(tagData?.independentData as Record<string, any> | null | undefined);
          if (hasV2IndependentTables) {
              appendTables(tagData?.independentData);
          }

          // ── 兼容旧 native：仅当该消息没有有效 V2 sheet 数据时，回退读取旧格式 ──
          if (!hasV2IndependentTables && isLegacyMatchForIsolation_ACU(message, isolationConfig)) {
              const legacyIndependent = readLegacyIndependentData_ACU(message);
              appendTables(legacyIndependent, { summaryOnly: false });

              const legacyStandard = readLegacyStandardData_ACU(message);
              appendTables(legacyStandard, { summaryOnly: false });

              // 历史模板 guide 只需要结构和参数，不需要把总结/大纲混入普通模板结构
              // 总结/大纲在运行时合并链路中由历史数据重建保障
          }
      }

      if (encounteredKeys.length === 0) return null;

      const orderedKeys = encounteredKeys
          .map((key, index) => ({
              key,
              index,
              order: Number.isFinite(historicalData?.[key]?.[TABLE_ORDER_FIELD_ACU])
                  ? Math.trunc(historicalData[key][TABLE_ORDER_FIELD_ACU])
                  : null,
          }))
          .sort((a, b) => {
              if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
              if (a.order !== null && b.order === null) return -1;
              if (a.order === null && b.order !== null) return 1;
              return a.index - b.index;
          })
          .map(item => item.key);

      applySheetOrderNumbers_ACU(historicalData, orderedKeys);
      return buildChatSheetGuideDataFromData_ACU(historicalData, {
          preserveSeedRowsFromGuideData: null,
          seedRowsFromTemplateObj: null,
          orderedKeys,
      });
  }

  function getLegacyTemplateSnapshotLabel_ACU(source = 'legacy_frozen') {
      if (source === 'legacy_history_frozen') return '旧对话历史模板快照';
      if (source === 'legacy_header_frozen') return '旧版表头冻结模板';
      return '旧版聊天冻结模板';
  }

  function buildChatTemplateScopeStateFromGuideData_ACU({ isolationKey = getCurrentIsolationKey_ACU(), presetName = '', source = 'legacy_frozen', originGlobalName = '', originGlobalRevision = 0, updatedAt = Date.now(), guideData = null as Record<string, any> | null } = {}) {
      const normalizedGuideData = normalizeGuideData_ACU(guideData);
      if (!normalizedGuideData || !Object.keys(normalizedGuideData).some(k => k.startsWith('sheet_'))) return null;
      const templateObj = materializeDataFromSheetGuide_ACU(normalizedGuideData, { includeSeedRows: true });
      return buildChatTemplateScopeStateFromCurrent_ACU({
          isolationKey,
          presetName,
          source,
          originGlobalName,
          originGlobalRevision,
          updatedAt,
          templateSource: templateObj,
          guideData: normalizedGuideData,
      });
  }

  export function migrateLegacyTemplateScopeForCurrentChat_ACU({ chat = getChatArray_ACU(), isolationKey = getCurrentIsolationKey_ACU() } = {}) {
      const normalizedKey = normalizeTemplateScopeIsolationKey_ACU(isolationKey);
      const existingScopeState = getCurrentChatTemplateScopeState_ACU({ chat, isolationKey: normalizedKey });
      if (existingScopeState) return existingScopeState;

      const persistMigratedState = (guideData: Record<string, any> | null, { source = 'legacy_frozen', updatedAt = Date.now() } = {}) => {
          const templateState = buildChatTemplateScopeStateFromGuideData_ACU({
              isolationKey: normalizedKey,
              presetName: getLegacyTemplateSnapshotLabel_ACU(source),
              source,
              originGlobalName: '',
              originGlobalRevision: 0,
              updatedAt,
              guideData,
          });
          if (!templateState) return null;
          return setCurrentChatTemplateScopeState_ACU(templateState, {
              isolationKey: normalizedKey,
              reason: `template_scope_${source}`,
          });
      };

      const container = getChatSheetGuideContainer_ACU(chat);
      const legacySlot = (container?.tags as Record<string, any> | undefined)?.[normalizedKey];
      const hasExplicitLegacyScopeMode = typeof legacySlot?.templateScopeMode === 'string' && legacySlot.templateScopeMode.trim() !== '';
      const legacySlotMode = hasExplicitLegacyScopeMode
          ? normalizeTemplateScopeMode_ACU(legacySlot.templateScopeMode)
          : 'chat_override';
      const legacyGuideData = normalizeGuideData_ACU(legacySlot?.data);
      if (legacySlotMode === 'chat_override' && legacyGuideData && Object.keys(legacyGuideData).some(k => k.startsWith('sheet_'))) {
          return persistMigratedState(legacyGuideData, {
              source: 'legacy_frozen',
              updatedAt: Number(legacySlot?.updatedAt) || Date.now(),
          });
      }

      const historicalGuideData = getHistoricalTemplateGuideDataForIsolationKey_ACU({ chat, isolationKey: normalizedKey });
      if (historicalGuideData && Object.keys(historicalGuideData).some(k => k.startsWith('sheet_'))) {
          return persistMigratedState(historicalGuideData, {
              source: 'legacy_history_frozen',
              updatedAt: Date.now(),
          });
      }

      const legacyHeaderGuideData = getLegacyHeaderGuideDataForIsolationKey_ACU({ chat, isolationKey: normalizedKey });
      if (legacyHeaderGuideData && Object.keys(legacyHeaderGuideData).some(k => k.startsWith('sheet_'))) {
          return persistMigratedState(legacyHeaderGuideData, {
              source: 'legacy_header_frozen',
              updatedAt: Date.now(),
          });
      }

      return null;
  }

  export function clearChatSheetGuideDataForIsolationKey_ACU({ chat = getChatArray_ACU(), isolationKey = getCurrentIsolationKey_ACU() } = {}) {
      const first = getChatFirstLayerMessage_ACU(chat);
      if (!first) return false;

      const container = getChatSheetGuideContainer_ACU(chat);
      if (!container || typeof container !== 'object' || !container.tags || typeof container.tags !== 'object') return false;

      const normalizedKey = String(isolationKey ?? '');
      if (!Object.prototype.hasOwnProperty.call(container.tags, normalizedKey)) return false;

      const nextContainer = cloneScopedConfigData_ACU(container, null) || { version: CHAT_SHEET_GUIDE_VERSION_ACU, tags: {} };
      if (!nextContainer.tags || typeof nextContainer.tags !== 'object') nextContainer.tags = {};
      delete nextContainer.tags[normalizedKey];

      if (Object.keys(nextContainer.tags).length === 0) {
          delete first[CHAT_SHEET_GUIDE_FIELD_ACU];
      } else {
          nextContainer.version = CHAT_SHEET_GUIDE_VERSION_ACU;
          first[CHAT_SHEET_GUIDE_FIELD_ACU] = nextContainer;
      }
      return true;
  }

  export function getChatSheetGuideDataForIsolationKey_ACU(isolationKey: string) {
      const chat = getChatArray_ACU();
      const normalizedKey = String(isolationKey ?? '');
      const scopedTemplateState = getCurrentChatTemplateScopeState_ACU({ chat, isolationKey: normalizedKey })
          || migrateLegacyTemplateScopeForCurrentChat_ACU({ chat, isolationKey: normalizedKey });
      const scopedGuideData = normalizeGuideData_ACU(scopedTemplateState?.guideData);
      if (scopedGuideData && Object.keys(scopedGuideData).some(k => k.startsWith('sheet_'))) {
          return scopedGuideData;
      }

      const buildGuideDataFromTemplateSource_ACU = (templateSource: any) => {
          const templateSnapshot = sanitizeTemplateSnapshotForChat_ACU(templateSource);
          const guideData = buildChatSheetGuideDataFromTemplateObj_ACU(templateSnapshot?.templateObj, { stripSeedRows: false });
          return (guideData && Object.keys(guideData).some(k => k.startsWith('sheet_'))) ? guideData : null;
      };

      if (scopedTemplateState?.mode === 'chat_override' && scopedTemplateState?.templateStr) {
          const overrideGuideData = buildGuideDataFromTemplateSource_ACU(scopedTemplateState.templateStr);
          if (overrideGuideData) {
              return overrideGuideData;
          }
      }

      if (scopedTemplateState?.mode === 'preset_link') {
          const linkedPresetName = normalizeTemplatePresetSelectionValue_ACU(scopedTemplateState?.presetName || '');
          const linkedTemplateSource = linkedPresetName
              ? (getTemplatePreset_ACU(linkedPresetName)?.templateStr || null)
              : getDefaultTemplateSnapshot_ACU()?.templateStr;
          const linkedGuideData = buildGuideDataFromTemplateSource_ACU(linkedTemplateSource);
          if (linkedGuideData) {
              return linkedGuideData;
          }
      }

      const activeTemplateGuideData = buildGuideDataFromTemplateSource_ACU(TABLE_TEMPLATE_ACU);
      if (activeTemplateGuideData) {
          return activeTemplateGuideData;
      }

      const globalSnapshot = getGlobalTemplateSnapshotForCurrentProfile_ACU();
      const globalGuideData = buildChatSheetGuideDataFromTemplateObj_ACU(globalSnapshot?.templateObj, { stripSeedRows: false });
      if (globalGuideData && Object.keys(globalGuideData).some(k => k.startsWith('sheet_'))) {
          return globalGuideData;
      }

      return null;
  }

  export function setChatSheetGuideDataForIsolationKey_ACU(isolationKey: string, guideData: Record<string, any> | null, { reason = '', syncTemplateScope = false, templateSource = null as any, presetName = '', source = '', updatedAt = Date.now() } = {}) {
      const chat = getChatArray_ACU();
      const first = getChatFirstLayerMessage_ACU(chat);
      if (!first) return false;

      const normalized = normalizeGuideData_ACU(guideData);
      if (!normalized || !Object.keys(normalized).some(k => k.startsWith('sheet_'))) return false;

      const normalizedKey = String(isolationKey ?? '');
      const existingTemplateScopeState = getCurrentChatTemplateScopeState_ACU({ chat, isolationKey: normalizedKey });
      const normalizedScopeMode = normalizeTemplateScopeMode_ACU(existingTemplateScopeState?.mode);
      const shouldSyncTemplateScope = !!syncTemplateScope || normalizedScopeMode === 'chat_override' || normalizedScopeMode === 'preset_link';
      const container: Record<string, any> = getChatSheetGuideContainer_ACU(chat) || { version: CHAT_SHEET_GUIDE_VERSION_ACU, tags: {} as Record<string, any> };
      if (!container.tags || typeof container.tags !== 'object') container.tags = {} as Record<string, any>;
      container.version = CHAT_SHEET_GUIDE_VERSION_ACU;
      container.tags[normalizedKey] = {
          data: normalized,
          updatedAt,
          reason: String(reason || ''),
          templateScopeMode: shouldSyncTemplateScope ? 'chat_override' : 'inherit_global',
      };
      first[CHAT_SHEET_GUIDE_FIELD_ACU] = container;
      if (shouldSyncTemplateScope) {
          const fallbackTemplateSource = existingTemplateScopeState?.templateStr || materializeDataFromSheetGuide_ACU(normalized, { includeSeedRows: true });
          const resolvedTemplateSource = templateSource || fallbackTemplateSource;
          const currentGlobalPresetName = normalizeTemplatePresetSelectionValue_ACU(getCurrentTemplatePresetName_ACU(settings_ACU, { requireExisting: false }));
          const resolvedPresetName = normalizeTemplatePresetSelectionValue_ACU(
              presetName || existingTemplateScopeState?.presetName || currentGlobalPresetName,
          );
          const resolvedSource = normalizeChatScopedConfigSource_ACU(
              source,
              existingTemplateScopeState?.source || (syncTemplateScope ? 'ui' : 'inherit'),
          );
          const templateState = buildChatTemplateScopeStateFromCurrent_ACU({
              isolationKey: normalizedKey,
              presetName: resolvedPresetName,
              source: resolvedSource,
              originGlobalName: normalizeTemplatePresetSelectionValue_ACU(
                  existingTemplateScopeState?.originGlobalName || currentGlobalPresetName,
              ),
              originGlobalRevision: Number.isFinite(existingTemplateScopeState?.originGlobalRevision)
                  ? existingTemplateScopeState.originGlobalRevision
                  : 0,
              updatedAt,
              templateSource: resolvedTemplateSource,
              guideData: normalized,
          });
          if (templateState) {
              setCurrentChatTemplateScopeState_ACU(templateState, {
                  isolationKey: normalizedKey,
                  reason: String(reason || `template_scope_${resolvedSource}`),
              });
              try {
                  upsertChatTemplatePresetEntry_ACU(templateState, { isolationKey: normalizedKey });
              } catch (e) { logWarn_ACU('[Guide] upsertChatPresetEntry 失败:', e); }
          }
      }
      return true;
  }

  // =========================
  // [新增] seedRows 解析/兜底：用于 $0 注入与"无数据初始化"场景
  // 目标：
  // - 新对话首次填表时，即使 currentJsonTableData_ACU 仅有表结构，也能从"内部指导表/模板"取到 seedRows
  // - 支持隔离标签切换或初始化早期 chat 尚未加载导致的"指导表未命中"情况
  // 注意：这里只把 seedRows 挂在表对象字段上，不会写入 content（不把模板基础数据当作真实聊天数据）
  // =========================
  let _seedRowsTemplateCacheStr_ACU: string | null = null;
  let _seedRowsTemplateCacheObj_ACU: Record<string, any> | null = null;

  function getTemplateObjForSeedRows_ACU() {
      try {
          if (_seedRowsTemplateCacheStr_ACU === TABLE_TEMPLATE_ACU && _seedRowsTemplateCacheObj_ACU) return _seedRowsTemplateCacheObj_ACU;
          const obj = parseTableTemplateJson_ACU({ stripSeedRows: false });
          _seedRowsTemplateCacheStr_ACU = TABLE_TEMPLATE_ACU;
          _seedRowsTemplateCacheObj_ACU = obj;
          return obj;
      } catch (e) {
          return null;
      }
  }

  export async function ensureChatSheetGuideSeeded_ACU({ reason = 'auto_seed_seedRows', force = false } = {}) {
      try {
          const isolationKey = getCurrentIsolationKey_ACU();
          const existing = getChatSheetGuideDataForIsolationKey_ACU(isolationKey);
          const hasExisting = !!(existing && typeof existing === 'object' && Object.keys(existing).some(k => k.startsWith('sheet_')));
          if (hasExisting && !force) return existing;

          const chat = getChatArray_ACU();
          if (!chat || !Array.isArray(chat) || chat.length === 0) return existing || null;

          const templateObj = getTemplateObjForSeedRows_ACU();
          if (!templateObj) return existing || null;

          // 用模板构建指导表（content 保留表头；seedRows 写入字段）
          const guideData = buildChatSheetGuideDataFromTemplateObj_ACU(templateObj, { stripSeedRows: true });
          if (!guideData) return existing || null;

          const ok = setChatSheetGuideDataForIsolationKey_ACU(isolationKey, guideData, { reason });
          if (ok) {
              try { await saveChatToHost_ACU(); } catch (e) { logWarn_ACU('[Guide] saveChatToHost 失败:', e); }
              logDebug_ACU(`[SheetGuide] Auto-seeded chat sheet guide for tag [${isolationKey || '无标签'}], reason=${reason}`);
          }
          return guideData;
      } catch (e) {
          return null;
      }
  }

  function pickAnyGuideSeedRowsSlot_ACU(sheetKey: string) {
      try {
          const chat = getChatArray_ACU();
          let best: { ts: number; seedRows: any[] } | null = null;
          const applyCandidate = (ts: number, data: Record<string, any> | null) => {
              const sr = data?.[sheetKey]?.[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU];
              if (!Array.isArray(sr) || sr.length === 0) return;
              if (!best || ts > best.ts) {
                  best = { ts, seedRows: sr };
              }
          };

          const scopedContainer = getChatScopedConfigContainer_ACU(chat);
          const scopedTemplateSlots = scopedContainer?.template;
          if (scopedTemplateSlots && typeof scopedTemplateSlots === 'object' && !Array.isArray(scopedTemplateSlots)) {
              Object.keys(scopedTemplateSlots).forEach((tagKey: string) => {
                  const slotState = normalizeChatTemplateScopeState_ACU((scopedTemplateSlots as Record<string, any>)[tagKey], { isolationKey: tagKey });
                  if (slotState.mode !== 'chat_override') return;
                  applyCandidate(Number(slotState.updatedAt) || 0, normalizeGuideData_ACU(slotState.guideData));
              });
          }
          if (best) {
              return JSON.parse(JSON.stringify(best.seedRows));
          }

          const container = getChatSheetGuideContainer_ACU(chat);
          const tags = container?.tags;
          if (!tags || typeof tags !== 'object') return null;
          Object.keys(tags).forEach((tagKey: string) => {
              const slot = (tags as Record<string, any>)[tagKey];
              const ts = Number(slot?.updatedAt) || 0;
              applyCandidate(ts, normalizeGuideData_ACU(slot?.data));
          });
          return best ? JSON.parse(JSON.stringify(best.seedRows)) : null;
      } catch (e) {
          return null;
      }
  }

  export function getEffectiveSeedRowsForSheet_ACU(sheetKey: string, { guideData = null as Record<string, any> | null, allowTemplateFallback = true } = {}) {
      try {
          if (!sheetKey || !String(sheetKey).startsWith('sheet_')) return [];
          const direct = currentJsonTableData_ACU?.[sheetKey]?.[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU];
          if (Array.isArray(direct) && direct.length > 0) return JSON.parse(JSON.stringify(direct));

          const g = guideData || (() => {
              const isolationKey = getCurrentIsolationKey_ACU();
              return getChatSheetGuideDataForIsolationKey_ACU(isolationKey);
          })();
          const sr1 = g?.[sheetKey]?.[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU];
          if (Array.isArray(sr1) && sr1.length > 0) return JSON.parse(JSON.stringify(sr1));

          const any = pickAnyGuideSeedRowsSlot_ACU(sheetKey);
          if (Array.isArray(any) && any.length > 0) return any;

          if (!allowTemplateFallback) return [];
          const templateObj = getTemplateObjForSeedRows_ACU();
          const tplRows = templateObj?.[sheetKey]?.content;
          if (Array.isArray(tplRows) && tplRows.length > 1) return JSON.parse(JSON.stringify(tplRows.slice(1)));
          return [];
      } catch (e) {
          return [];
      }
  }

  export function attachSeedRowsToCurrentDataFromGuide_ACU(guideData: Record<string, any> | null) {
      try {
          if (!currentJsonTableData_ACU || typeof currentJsonTableData_ACU !== 'object') return false;
          const g = normalizeGuideData_ACU(guideData);
          if (!g) return false;
          let changed = false;
          Object.keys(currentJsonTableData_ACU).forEach(k => {
              if (!k.startsWith('sheet_')) return;
              const table = currentJsonTableData_ACU[k];
              if (!table || typeof table !== 'object') return;
              const existing = table?.[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU];
              if (Array.isArray(existing) && existing.length > 0) return;
              const sr = g?.[k]?.[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU];
              if (Array.isArray(sr) && sr.length > 0) {
                  table[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU] = JSON.parse(JSON.stringify(sr));
                  changed = true;
              }
          });
          return changed;
      } catch (e) {
          return false;
      }
  }

  // [新增] 用"当前数据"构建空白指导表：只保留表头行 + 参数（顺序由 getSortedSheetKeys_ACU 的旧逻辑决定，避免递归）
  export function buildChatSheetGuideDataFromData_ACU(dataObj: Record<string, any> | null, { preserveSeedRowsFromGuideData = null as Record<string, any> | null, seedRowsFromTemplateObj = null as Record<string, any> | null, orderedKeys = null as string[] | null } = {}) {
      if (!dataObj || typeof dataObj !== 'object') return null;
      const keys = Array.isArray(orderedKeys) && orderedKeys.length
          ? orderedKeys.filter(k => typeof k === 'string' && k.startsWith('sheet_') && dataObj[k])
          : getSortedSheetKeys_ACU(dataObj, { ignoreChatGuide: true });
      const out: any = { mate: { type: 'chatSheets', version: CHAT_SHEET_GUIDE_VERSION_ACU } };
      if (dataObj.mate && typeof dataObj.mate === 'object') {
          out.mate = JSON.parse(JSON.stringify(dataObj.mate));
      }
      out.mate.globalInjectionConfig = ensureGlobalInjectionConfigDefaults_ACU(out.mate.globalInjectionConfig);
      keys.forEach((k: string) => {
          const s = dataObj[k];
          if (!s) return;
          const headerRow = Array.isArray(s.content) && Array.isArray(s.content[0]) ? JSON.parse(JSON.stringify(s.content[0])) : ["row_id"];
          const blank: Record<string, any> = {
              uid: s.uid || k,
              name: s.name || k,
              sourceData: s.sourceData ? JSON.parse(JSON.stringify(s.sourceData)) : { note: '', initNode: '', insertNode: '', updateNode: '', deleteNode: '' },
              content: [headerRow],
              updateConfig: s.updateConfig ? JSON.parse(JSON.stringify(s.updateConfig)) : { uiSentinel: -1, contextDepth: -1, updateFrequency: -1, batchSize: -1, skipFloors: -1, sendLatestRows: -1, groupId: -1 },
              exportConfig: ensureExportConfigDefaults_ACU(
                  s.exportConfig ? JSON.parse(JSON.stringify(s.exportConfig)) : null,
                  s.name || k
              ),
          };
          // 需求4：结构/表名/参数变更时，仅更新指导表元信息，不修改"基础数据(seedRows)"
          const preserved = preserveSeedRowsFromGuideData?.[k]?.[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU];
          if (Array.isArray(preserved)) {
              blank[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU] = JSON.parse(JSON.stringify(preserved));
          } else {
              // 需求1：首次生成指导表时，把模板预置数据写入 seedRows（仅在未能从既有指导表继承时）
              const tplRows = seedRowsFromTemplateObj?.[k]?.content;
              if (Array.isArray(tplRows) && tplRows.length > 1) {
                  blank[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU] = JSON.parse(JSON.stringify(tplRows.slice(1)));
              }
          }
          if (Number.isFinite(s?.[TABLE_ORDER_FIELD_ACU])) blank[TABLE_ORDER_FIELD_ACU] = Math.trunc(s[TABLE_ORDER_FIELD_ACU]);
          out[k] = blank;
      });
      return normalizeGuideData_ACU(out);
  }

  // [新增] 用"模板对象"构建空白指导表：只保留表头行 + 参数（模板已有顺序编号）
  export function buildChatSheetGuideDataFromTemplateObj_ACU(templateObj: Record<string, any> | null, { stripSeedRows = true } = {}) {
      if (!templateObj || typeof templateObj !== 'object') return null;
      const keys = Object.keys(templateObj).filter(k => k.startsWith('sheet_'));
      if (keys.length === 0) return null;
      // 确保模板编号稳定（缺失则补齐）
      try { ensureSheetOrderNumbers_ACU(templateObj, { baseOrderKeys: keys, forceRebuild: false }); } catch (e) { logWarn_ACU('[Guide] ensureSheetOrderNumbers 失败:', e); }
      const sorted = keys.sort((a, b) => {
          const ao = Number.isFinite(templateObj?.[a]?.[TABLE_ORDER_FIELD_ACU]) ? Math.trunc(templateObj[a][TABLE_ORDER_FIELD_ACU]) : Infinity;
          const bo = Number.isFinite(templateObj?.[b]?.[TABLE_ORDER_FIELD_ACU]) ? Math.trunc(templateObj[b][TABLE_ORDER_FIELD_ACU]) : Infinity;
          if (ao !== bo) return ao - bo;
          return String(a).localeCompare(String(b));
      });
      const out: any = { mate: { type: 'chatSheets', version: CHAT_SHEET_GUIDE_VERSION_ACU } };
      if (templateObj.mate && typeof templateObj.mate === 'object') {
          out.mate = JSON.parse(JSON.stringify(templateObj.mate));
      }
      out.mate.globalInjectionConfig = ensureGlobalInjectionConfigDefaults_ACU(out.mate.globalInjectionConfig);
      sorted.forEach((k: string, idx: number) => {
          const base = JSON.parse(JSON.stringify(templateObj[k] || {}));
          base.uid = base.uid || k;
          base.name = base.name || k;
          if (!Array.isArray(base.content) || base.content.length === 0 || !Array.isArray(base.content[0]) || base.content[0].length === 0) {
              // content[0] 缺失或为空 → 尝试从 sourceData.ddl 推导中文表头行
              const ddl = base.sourceData?.ddl;
              if (ddl && typeof ddl === 'string') {
                  try {
                      const comments = parseDDLColumnComments(ddl);
                      base.content = [parseDDLColumnNames(ddl).map(sqlName => comments.get(sqlName) || sqlName)];
                  } catch (_) { base.content = [["row_id"]]; }
              } else {
                  base.content = [["row_id"]];
              }
          }
          // v2: 保存模板预置数据为 seedRows，但指导表本体 content 仍只保留表头
          if (Array.isArray(base.content) && base.content.length > 1) {
              base[CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU] = JSON.parse(JSON.stringify(base.content.slice(1)));
          }
          if (stripSeedRows && Array.isArray(base.content) && base.content.length > 1) base.content = [base.content[0]];
          if (!Number.isFinite(base[TABLE_ORDER_FIELD_ACU])) base[TABLE_ORDER_FIELD_ACU] = idx;
          out[k] = base;
      });
      return normalizeGuideData_ACU(out);
  }

  // [新增] 覆盖式更新：用模板写入当前聊天第一层"空白指导表"
  export async function overwriteChatSheetGuideFromTemplate_ACU(templateObj: Record<string, any> | null, { reason = 'template_changed', stripSeedRows = true, presetName = '', source = 'ui', syncTemplateScope = false, registerPreset = false } = {}) {
      const guideData = buildChatSheetGuideDataFromTemplateObj_ACU(templateObj, { stripSeedRows });
      if (!guideData) return false;
      const isolationKey = getCurrentIsolationKey_ACU();
      const templateSnapshot = sanitizeTemplateSnapshotForChat_ACU(templateObj);
      const normalizedPresetName = deriveTemplatePresetNameForImport_ACU({ presetName });
      if (registerPreset && normalizedPresetName && templateSnapshot?.templateStr) {
          try {
              const savePresetOk = upsertTemplatePreset_ACU(normalizedPresetName, templateSnapshot.templateStr);
              if (!savePresetOk) {
                  logWarn_ACU(`[TemplateScope] 保存模板预设失败：${normalizedPresetName}`);
              }
          } catch (e) {
              logWarn_ACU('[TemplateScope] 保存模板预设失败:', e);
          }
      }
      const ok = setChatSheetGuideDataForIsolationKey_ACU(isolationKey, guideData, {
          reason,
          syncTemplateScope,
          templateSource: templateSnapshot?.templateStr || templateObj,
          presetName: normalizedPresetName,
          source,
      });
      if (!ok) return false;
      if (syncTemplateScope) {
          try { applyTemplateScopeForCurrentChat_ACU(); } catch (e) { logWarn_ACU('[Guide] applyTemplateScope 失败:', e); }
      }
      try { await saveChatToHost_ACU(); } catch (e) { logWarn_ACU('[Guide] saveChatToHost 失败:', e); }
      try { await refreshMergedDataAndNotify_ACU(); } catch (e) {}
      return true;
  }

  // [表格顺序新机制] 获取表格 keys：
  // - 若当前聊天已存在"空白指导表"：优先按指导表的 orderNo 顺序（可过滤不在指导表里的表）
  // - 否则：按"编号(orderNo)从小到大"排序；缺编号则回退到模板编号/模板顺序
