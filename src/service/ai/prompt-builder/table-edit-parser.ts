/**
 * service/ai/prompt-builder/table-edit-parser.ts
 * AI 响应表格编辑解析 — <tableEdit> 块提取 + 指令解析 + 编辑应用
 * 从 prompt-builder.ts 拆出（L502-L1519）
 * JSON 清洗管线已提取到 json-sanitizer.ts
 */
import { currentJsonTableData_ACU, settings_ACU } from '../../runtime/state-manager';
import { getEffectiveSeedRowsForSheet_ACU, getSortedSheetKeys_ACU } from '../../template/chat-scope';
import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU } from '../../../shared/utils';
import { applySummaryIndexSequenceToTable_ACU, formatSummaryIndexCode_ACU, getSummaryIndexColumnIndex_ACU, getTableLocksForSheet_ACU, isSpecialIndexLockEnabled_ACU } from '../../runtime/helpers-remaining';
import { sanitizeJsonPipeline_ACU, coerceLooseRowObject_ACU } from './json-sanitizer';
import { isSqliteMode } from '../../table/storage-mode';
import { getStorageProvider } from '../../table/table-storage-strategy';

  function normalizeAiResponseForTableEditParsing_ACU(text: string) {
    if (typeof text !== 'string') return '';
    let cleaned = text.trim();
    cleaned = cleaned.replace(/'\s*\+\s*'/g, '');
    if (cleaned.startsWith("'") && cleaned.endsWith("'")) cleaned = cleaned.slice(1, -1);
    cleaned = cleaned.replace(/\\n/g, '\n');
    cleaned = cleaned.replace(/\\\\"/g, '\\"');
    cleaned = cleaned.replace(/：/g, ':');
    return cleaned;
  }

  export function extractTableEditInner_ACU(text: string, options: any = {}) {
    const { allowNoTableEditTags = true, useLastPairOnly = (settings_ACU?.tableEditLastPairOnly !== false) } = options;
    const cleaned = normalizeAiResponseForTableEditParsing_ACU(text);
    if (!cleaned) return null;

    if (useLastPairOnly) {
      const fullRe = /<tableEdit>([\s\S]*?)<\/tableEdit>/ig;
      let lastMatch = null;
      let m;
      while ((m = fullRe.exec(cleaned)) !== null) {
        lastMatch = m;
      }
      if (lastMatch && typeof lastMatch[1] === 'string') {
        return { inner: lastMatch[1], cleaned, mode: 'full_last' };
      }
    } else {
      const fullMatch = cleaned.match(/<tableEdit>([\s\S]*?)<\/tableEdit>/i);
      if (fullMatch && typeof fullMatch[1] === 'string') {
        return { inner: fullMatch[1], cleaned, mode: 'full' };
      }
    }

    const lowerCleaned = cleaned.toLowerCase();
    const openTag = '<tableedit>';
    const closeTag = '</tableedit>';
    const hasOpen = lowerCleaned.includes(openTag);
    const hasClose = lowerCleaned.includes(closeTag);
    const hasAnyTag = hasOpen || hasClose;

    const commentRe = /<!--([\s\S]*?)-->/g;
    const commentBlocks = [];
    let m;
    while ((m = commentRe.exec(cleaned)) !== null) {
      commentBlocks.push({
        start: m.index,
        end: commentRe.lastIndex,
        raw: m[0],
        content: m[1] || ''
      });
    }

    const hasCommands = (s: string) => /(insertRow|updateRow|deleteRow)\s*\(/.test(s);
    const candidates = commentBlocks.filter(b => hasCommands(b.content));
    if (!candidates.length) return null;

    let chosen = null;
    if (hasOpen && !hasClose) {
      const openIdx = useLastPairOnly ? lowerCleaned.lastIndexOf(openTag) : cleaned.search(/<tableEdit>/i);
      chosen = candidates.find(b => b.start > openIdx) || (useLastPairOnly ? candidates[candidates.length - 1] : candidates[0]);
    } else if (!hasOpen && hasClose) {
      const closeIdx = useLastPairOnly ? lowerCleaned.lastIndexOf(closeTag) : cleaned.search(/<\/tableEdit>/i);
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].end < closeIdx) { chosen = candidates[i]; break; }
      }
      chosen = chosen || candidates[candidates.length - 1];
    } else if (hasAnyTag) {
      const lastOpenIdx = lowerCleaned.lastIndexOf(openTag);
      const lastCloseIdx = lowerCleaned.lastIndexOf(closeTag);
      const tagIdx = useLastPairOnly
        ? (lastCloseIdx !== -1 ? lastCloseIdx : lastOpenIdx)
        : (hasOpen ? cleaned.search(/<tableEdit>/i) : cleaned.search(/<\/tableEdit>/i));
      let bestDist = Infinity;
      candidates.forEach(b => {
        const dist = Math.min(Math.abs(b.start - tagIdx), Math.abs(b.end - tagIdx));
        if (dist < bestDist) { bestDist = dist; chosen = b; }
      });
    } else if (allowNoTableEditTags) {
      chosen = useLastPairOnly ? candidates[candidates.length - 1] : candidates[0];
    }

    if (!chosen) return null;
    return { inner: chosen.raw, cleaned, mode: 'comment_fallback', hasOpen, hasClose };
  }

  export function parseAndApplyTableEdits_ACU(aiResponse: string, updateMode = 'standard', isImportMode = false) {
    if (!currentJsonTableData_ACU) {
        logError_ACU('Cannot apply edits, currentJsonTableData_ACU is not loaded.');
        return false;
    }

    const extracted = extractTableEditInner_ACU(aiResponse, { allowNoTableEditTags: true });
    if (!extracted || !extracted.inner) {
        logWarn_ACU('No recognizable table edit block found (missing <tableEdit> boundary and/or incomplete <!-- --> wrapper).');
        return true;
    }

    const editsString = extracted.inner.replace(/<!--|-->/g, '').trim();
    if (!editsString) {
        logDebug_ACU('Empty <tableEdit> block. No edits to apply.');
        return true;
    }

    // [新增] SQLite 模式：检测是否为 SQL 语句，是则走 SQL 执行路径
    if (isSqliteMode() && isSqlContent(editsString)) {
        try {
            const provider = getStorageProvider();
            const result = provider.applyEdits(editsString, updateMode);
            logDebug_ACU(`[SQL Mode] applyEdits 完成: success=${result.success}, appliedEdits=${result.appliedEdits}, modifiedKeys=${result.modifiedKeys.join(',')}`);
            return result;
        } catch (e: any) {
            // SQL 执行失败，抛出错误供上层重试循环捕获
            logError_ACU(`[SQL Mode] SQL 执行失败: ${e?.message}`);
            throw e;
        }
    }
    
    // 指令重组：处理 AI 生成的多行指令
    const originalLines = editsString.split('\n');
    const commandLines = [];
    let commandReconstructor = '';
    let isInJsonBlock = false;

    originalLines.forEach(line => {
        const trimmedLine = line.trim();
        if (trimmedLine === '') return;

        let lineContent = trimmedLine;
        if (!isInJsonBlock && lineContent.includes('//') && !lineContent.includes('"//') && !lineContent.includes("'//")) {
             lineContent = lineContent.split('//')[0].trim();
        }
        if (lineContent === '') return;

        if ((lineContent.startsWith('insertRow') || lineContent.startsWith('deleteRow') || lineContent.startsWith('updateRow')) && !isInJsonBlock) {
            if (commandReconstructor) {
                commandLines.push(commandReconstructor);
            }
            commandReconstructor = lineContent;
        } else {
            commandReconstructor += ' ' + lineContent;
        }

        if (commandReconstructor) {
            const totalOpen = (commandReconstructor.match(/{/g) || []).length;
            const totalClose = (commandReconstructor.match(/}/g) || []).length;
            if (totalOpen > totalClose) {
                isInJsonBlock = true;
            } else {
                isInJsonBlock = false;
            }
        }
    });

    if (commandReconstructor) {
        commandLines.push(commandReconstructor);
    }
    
    // 二次处理：拆分挤在一行里的多条指令
    const finalCommandLines: string[] = [];
    commandLines.forEach(line => {
        const multiCommandPattern = /(?:^|;\s*)((?:insertRow|deleteRow|updateRow)\s*\()/g;
        const positions = [];
        let match;
        while ((match = multiCommandPattern.exec(line)) !== null) {
            positions.push(match.index + (match[0].length - match[1].length));
        }
        if (positions.length <= 1) {
            finalCommandLines.push(line.replace(/;\s*$/, ''));
        } else {
            for (let i = 0; i < positions.length; i++) {
                const start = positions[i];
                const end = i + 1 < positions.length ? positions[i + 1] : line.length;
                const subCommand = line.substring(start, end).replace(/;\s*$/, '').trim();
                if (subCommand) finalCommandLines.push(subCommand);
            }
        }
    });

    const sheetKeysForIndexing = getSortedSheetKeys_ACU(currentJsonTableData_ACU);
    const sheets = sheetKeysForIndexing.map(key => currentJsonTableData_ACU[key]);
    let appliedEdits = 0;
    const editCountsByTable: Record<string, number> = {};

    // [表名容错] 构建「表名 → 数字索引」查找表，兼容 AI 使用 SQL 表名或中文表名代替数字索引的情况
    const sheetNameToIndex_ACU: Record<string, number> = {};
    sheets.forEach((sheet, idx) => {
        if (sheet && sheet.name) {
            sheetNameToIndex_ACU[sheet.name] = idx;  // 中文名映射，如 "广场主贴表" → 22
        }
        // 从 DDL 中提取 SQL 表名做映射，如 "square_posts" → 22
        if (sheet && sheet.sourceData && sheet.sourceData.ddl) {
            const ddlMatch = sheet.sourceData.ddl.match(/CREATE\s+TABLE\s+(\w+)/i);
            if (ddlMatch && ddlMatch[1]) {
                sheetNameToIndex_ACU[ddlMatch[1]] = idx;
            }
        }
    });

    // [表名容错] 辅助函数：将可能是表名的参数解析为数字索引
    const resolveTableNameParams_ACU = (rawParamsStr: string): number[] | null => {
        const rawParams = rawParamsStr.split(',').map(s => s.trim());
        const resolved: number[] = [];
        for (const p of rawParams) {
            if (/^\d+$/.test(p)) {
                resolved.push(parseInt(p, 10));
                continue;
            }
            const cleanName = p.replace(/^["']|["']$/g, '');
            if (sheetNameToIndex_ACU.hasOwnProperty(cleanName)) {
                logDebug_ACU(`[表名容错] 将表名 "${cleanName}" 解析为索引 ${sheetNameToIndex_ACU[cleanName]}`);
                resolved.push(sheetNameToIndex_ACU[cleanName]);
                continue;
            }
            logWarn_ACU(`[表名容错] 无法识别的 tableIndex: "${p}"`);
            return null;  // 无法解析，放弃容错
        }
        return resolved;
    };

    // 指令解析函数
    const parseTableEditCommandLine_ACU = (rawLine: string) => {
        try {
            let commandLineWithoutComment = rawLine;
            if (commandLineWithoutComment.match(/\)\s*;?\s*\/\/.*$/)) {
                commandLineWithoutComment = commandLineWithoutComment.replace(/\/\/.*$/, '').trim();
            }
            if (!commandLineWithoutComment) return null;
            const match = commandLineWithoutComment.match(/^(insertRow|deleteRow|updateRow)\s*\((.*)\);?$/);
            if (!match) return null;
            const command = match[1];
            const argsString = match[2];
            let args;
            const firstBracket = argsString.indexOf('{');
            if (firstBracket === -1) {
                try {
                    args = JSON.parse(`[${argsString}]`);
                } catch (_simpleParseErr) {
                    // [表名容错] deleteRow 等简单指令可能使用了表名代替数字索引
                    const resolved = resolveTableNameParams_ACU(argsString);
                    if (resolved) {
                        args = resolved;
                    } else {
                        throw _simpleParseErr;
                    }
                }
            } else {
                const paramsPart = argsString.substring(0, firstBracket).trim();
                let jsonPart = argsString.substring(firstBracket);
                let initialArgs: any[];
                try {
                    initialArgs = JSON.parse(`[${paramsPart.replace(/,$/, '')}]`);
                } catch (_paramParseErr) {
                    // [表名容错] insertRow/updateRow 的前置参数可能使用了表名代替数字索引
                    const resolved = resolveTableNameParams_ACU(paramsPart.replace(/,$/, ''));
                    if (resolved) {
                        initialArgs = resolved;
                    } else {
                        throw _paramParseErr;
                    }
                }
                try {
                    const jsonData = JSON.parse(jsonPart);
                    args = [...initialArgs, jsonData];
                } catch (jsonError) {
                    logError_ACU(`Primary JSON parse failed for: "${jsonPart}". Attempting sanitization pipeline...`, jsonError);

                    const originalLooseObjectResult = coerceLooseRowObject_ACU(jsonPart);
                    if (originalLooseObjectResult.success) {
                        args = [...initialArgs, originalLooseObjectResult.result];
                        logWarn_ACU(`[JSON Sanitization] Recovered malformed row object from original payload via loose parsing. Keys: ${originalLooseObjectResult.recoveredKeys.join(', ')}`);
                    } else {
                        const sanitizeResult = sanitizeJsonPipeline_ACU(jsonPart);
                        if (!sanitizeResult.success) {
                            logError_ACU(`JSON sanitization pipeline failed for: "${jsonPart}"`, new Error(sanitizeResult.error || 'Unknown sanitization error'));
                            throw jsonError;
                        }

                        try {
                            const jsonData = JSON.parse(sanitizeResult.result);
                            args = [...initialArgs, jsonData];
                            if (sanitizeResult.layersApplied.length > 0) {
                                logWarn_ACU(`[JSON Sanitization] Applied layers: ${sanitizeResult.layersApplied.join(', ')}`);
                            }
                        } catch (sanitizedJsonError) {
                            const looseObjectResult = coerceLooseRowObject_ACU(sanitizeResult.result);
                            if (looseObjectResult.success) {
                                args = [...initialArgs, looseObjectResult.result];
                                logWarn_ACU(`[JSON Sanitization] Recovered malformed row object from sanitized payload via loose parsing. Keys: ${looseObjectResult.recoveredKeys.join(', ')}`);
                            } else {
                                const sanitizedPreview = sanitizeResult.result.length > 400
                                    ? `${sanitizeResult.result.slice(0, 400)}...`
                                    : sanitizeResult.result;
                                logError_ACU(`Sanitized JSON parse failed after layers [${sanitizeResult.layersApplied.join(', ') || 'none'}]: "${sanitizedPreview}"`, sanitizedJsonError);
                                logError_ACU(`[JSON Sanitization] Loose row object recovery failed. Original: ${originalLooseObjectResult.error || 'Unknown'}; Sanitized: ${looseObjectResult.error || 'Unknown'}`);
                                throw sanitizedJsonError;
                            }
                        }
                    }
                }
            }
            return { command, args, line: commandLineWithoutComment };
        } catch (e) {
            logError_ACU(`Failed to parse command line: "${rawLine}"`, e);
            return null;
        }
    };

    // 总结表/总体大纲同步新增检查
    let summaryInsertCount = 0;
    let outlineInsertCount = 0;
    const standardizedFillEnabled = settings_ACU?.standardizedTableFillEnabled !== false;
    if (standardizedFillEnabled) {
        finalCommandLines.forEach(line => {
            try {
                const parsed = parseTableEditCommandLine_ACU(line);
                if (!parsed || parsed.command !== 'insertRow') return;
                const tableIndex = parsed.args?.[0];
                const table = sheets[tableIndex];
                if (!table || !table.name) return;
                if (!isSummaryOrOutlineTable_ACU(table.name)) return;
                if (table.name === '总结表') summaryInsertCount++;
                if (table.name === '总体大纲') outlineInsertCount++;
            } catch (e) {}
        });
    }
    const allowSummaryOutlineInsert = !standardizedFillEnabled ||
        (summaryInsertCount === 1 && outlineInsertCount === 1) ||
        (summaryInsertCount === 0 && outlineInsertCount === 0);
    if (standardizedFillEnabled && !allowSummaryOutlineInsert && (summaryInsertCount > 0 || outlineInsertCount > 0)) {
        logWarn_ACU(`[屏蔽] 总结表/总体大纲新增不同步：总结=${summaryInsertCount}, 大纲=${outlineInsertCount}，本轮两表均不写入。`);
    }

    // seedRows 物化
    const materializeSeedRowsIfNeeded_ACU = (table: any) => {
        try {
            if (!table || typeof table !== 'object') return;
            if (!Array.isArray(table.content) || table.content.length !== 1) return;
            let sr = (Array.isArray(table.seedRows) && table.seedRows.length > 0) ? table.seedRows : null;
            if (!sr && table.uid && String(table.uid).startsWith('sheet_')) {
                sr = getEffectiveSeedRowsForSheet_ACU(String(table.uid), { guideData: null, allowTemplateFallback: true });
                if (Array.isArray(sr) && sr.length > 0) {
                    try { table.seedRows = JSON.parse(JSON.stringify(sr)); } catch (e) {}
                }
            }
            if (!Array.isArray(sr) || sr.length === 0) return;
    const headerRow = Array.isArray(table.content[0]) ? JSON.parse(JSON.stringify(table.content[0])) : ["row_id"];
            const seed = JSON.parse(JSON.stringify(sr));
            table.content = [headerRow, ...seed];
        } catch (e) { logWarn_ACU('[表格编辑] restoreSeedRows 失败:', e); }
    };

    // 逐条应用编辑指令
    finalCommandLines.forEach(line => {
        const parsed = parseTableEditCommandLine_ACU(line);
        if (!parsed) {
            logWarn_ACU(`Skipping malformed or truncated command line: "${line}"`);
            return;
        }
        const { command, args } = parsed;

        try {
            switch (command) {
                case 'insertRow': {
                    const [tableIndex, data] = args;
                    const table = sheets[tableIndex];
                    if (!table || !table.name) {
                        logWarn_ACU(`Table at index ${tableIndex} not found or has no name. Skipping insertRow.`);
                        break;
                    }
                    materializeSeedRowsIfNeeded_ACU(table);
                    const sheetKey = sheetKeysForIndexing[tableIndex];
                    const isSummaryTable = isSummaryOrOutlineTable_ACU(table.name);
                    const isUnifiedMode = (updateMode === 'full' || updateMode === 'manual_unified' || updateMode === 'auto_unified');
                    const isStandardMode = (updateMode === 'standard' || updateMode === 'auto_standard' || updateMode === 'manual_standard');
                    const isSummaryMode = (updateMode === 'summary' || updateMode === 'auto_summary' || updateMode === 'auto_summary_silent' || updateMode === 'manual_summary');
                    const isManualMode = (updateMode && updateMode.startsWith('manual'));

                    if (isUnifiedMode) {
                        // 允许所有操作
                    } else if (isStandardMode && isSummaryTable) {
                        if (isManualMode) {
                            logDebug_ACU(`[屏蔽] 标准表更新模式(手动)：忽略总结表/总体大纲的insertRow操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                            break;
                        }
                    } else if (isSummaryMode && !isSummaryTable) {
                        if (isManualMode) {
                            logDebug_ACU(`[屏蔽] 总结表更新模式(手动)：忽略标准表的insertRow操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                            break;
                        }
                    }
                    if (isSummaryTable && !allowSummaryOutlineInsert) {
                        logDebug_ACU(`[屏蔽] 总结表/总体大纲新增不同步：忽略 insertRow (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                        break;
                    }
                    if (table && table.content && typeof data === 'object') {
                        const newRow: any[] = [String(table.content.length)]; // 行号 = 当前 content 长度（表头占 [0]）
                        const headers = table.content[0].slice(1);

                        // [row_id 去重] AI 可能在 data 对象中传入了 row_id（key=0），
                        // 导致自动生成的 row_id 与 data[0] 形成双重序号，后续列整体右移。
                        // 检测条件：data 的 key 数量 > headers 数量，且 data[0] 看起来像 row_id（纯数字）。
                        // 修复方式：将 data 的 key 整体左移一位，丢弃 data[0]。
                        const dataKeys = Object.keys(data);
                        const numericKeys = dataKeys.filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
                        if (numericKeys.length > headers.length && numericKeys[0] === 0) {
                            const val0 = String(data[0] ?? data['0'] ?? '');
                            const autoRowId = String(table.content.length);
                            if (/^\d+$/.test(val0) && (val0 === autoRowId || parseInt(val0, 10) >= 1)) {
                                logWarn_ACU(`[row_id 去重] 检测到 data[0]="${val0}" 疑似多余的 row_id（auto="${autoRowId}"），将 data key 整体左移。`);
                                const shifted: Record<string, any> = {};
                                for (let i = 1; i <= numericKeys[numericKeys.length - 1]; i++) {
                                    shifted[i - 1] = data[i] ?? data[String(i)] ?? '';
                                }
                                // 替换 data 引用
                                Object.keys(data).forEach(k => delete data[k]);
                                Object.assign(data, shifted);
                            }
                        }
                        const specialIndexCol = (isSummaryTable && sheetKey && isSpecialIndexLockEnabled_ACU(sheetKey))
                            ? getSummaryIndexColumnIndex_ACU(table)
                            : -1;
                        headers.forEach((_: any, colIndex: number) => {
                            let nextVal = data[colIndex] || (data[String(colIndex)] || "");
                            if (colIndex === specialIndexCol) {
                                nextVal = formatSummaryIndexCode_ACU(table.content.length);
                            }
                            newRow.push(nextVal);
                        });
                        table.content.push(newRow);
                        if (isSummaryTable && specialIndexCol >= 0) {
                            applySummaryIndexSequenceToTable_ACU(table, specialIndexCol);
                        }
                        logDebug_ACU(`Applied insertRow to table ${tableIndex} (${table.name}) with data:`, data);
                        appliedEdits++;
                        editCountsByTable[table.name] = (editCountsByTable[table.name] || 0) + 1;
                    }
                    break;
                }
                case 'deleteRow': {
                    const [tableIndex, rowIndex] = args;
                    const table = sheets[tableIndex];
                    if (!table || !table.name) {
                        logWarn_ACU(`Table at index ${tableIndex} not found or has no name. Skipping deleteRow.`);
                        break;
                    }
                    materializeSeedRowsIfNeeded_ACU(table);
                    const isSummaryTable = isSummaryOrOutlineTable_ACU(table.name);

                    if (isSummaryTable) {
                        logDebug_ACU(`[屏蔽] 总结表/总体大纲忽略 deleteRow 操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                        break;
                    }

                    const isUnifiedMode = (updateMode === 'full' || updateMode === 'manual_unified' || updateMode === 'auto_unified');
                    const isStandardMode = (updateMode === 'standard' || updateMode === 'auto_standard' || updateMode === 'manual_standard');
                    const isSummaryMode = (updateMode === 'summary' || updateMode === 'auto_summary' || updateMode === 'auto_summary_silent' || updateMode === 'manual_summary');
                    const isManualMode = (updateMode && updateMode.startsWith('manual'));

                    if (isUnifiedMode) {
                        // 允许所有操作
                    } else if (isStandardMode && isSummaryTable) {
                        if (isManualMode) {
                            logDebug_ACU(`[屏蔽] 标准表更新模式(手动)：忽略总结表/总体大纲的deleteRow操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                            break;
                        }
                    } else if (isSummaryMode && !isSummaryTable) {
                        if (isManualMode) {
                            logDebug_ACU(`[屏蔽] 总结表更新模式(手动)：忽略标准表的deleteRow操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                            break;
                        }
                    }
                    if (table && table.content && table.content.length > rowIndex + 1) {
                        table.content.splice(rowIndex + 1, 1);
                        logDebug_ACU(`Applied deleteRow to table ${tableIndex} (${table.name}) at index ${rowIndex}`);
                        appliedEdits++;
                        editCountsByTable[table.name] = (editCountsByTable[table.name] || 0) + 1;
                    }
                    break;
                }
                case 'updateRow': {
                    const [tableIndex, rowIndex, data] = args;
                    const table = sheets[tableIndex];
                    if (!table || !table.name) {
                        logWarn_ACU(`Table at index ${tableIndex} not found or has no name. Skipping updateRow.`);
                        break;
                    }
                    materializeSeedRowsIfNeeded_ACU(table);
                    const sheetKey = sheetKeysForIndexing[tableIndex];
                    const isSummaryTable = isSummaryOrOutlineTable_ACU(table.name);

                    if (isSummaryTable) {
                        logDebug_ACU(`[屏蔽] 总结表/总体大纲忽略 updateRow 操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                        break;
                    }

                    const isUnifiedMode = (updateMode === 'full' || updateMode === 'manual_unified' || updateMode === 'auto_unified');
                    const isStandardMode = (updateMode === 'standard' || updateMode === 'auto_standard' || updateMode === 'manual_standard');
                    const isSummaryMode = (updateMode === 'summary' || updateMode === 'auto_summary' || updateMode === 'auto_summary_silent' || updateMode === 'manual_summary');
                    const isManualMode = (updateMode && updateMode.startsWith('manual'));

                    if (isUnifiedMode) {
                        // 允许所有操作
                    } else if (isStandardMode && isSummaryTable) {
                        if (isManualMode) {
                            logDebug_ACU(`[屏蔽] 标准表更新模式(手动)：忽略总结表/总体大纲的updateRow操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                            break;
                        }
                    } else if (isSummaryMode && !isSummaryTable) {
                        if (isManualMode) {
                            logDebug_ACU(`[屏蔽] 总结表更新模式(手动)：忽略标准表的updateRow操作 (tableIndex: ${tableIndex}, tableName: ${table.name})`);
                            break;
                        }
                    }
                    if (table && table.content && table.content.length > rowIndex + 1 && typeof data === 'object') {
                        const lockState = sheetKey ? getTableLocksForSheet_ACU(sheetKey) : { rows: new Set(), cols: new Set(), cells: new Set() };
                        if (lockState.rows.has(rowIndex)) {
                            logDebug_ACU(`[锁定] 行锁定阻止 updateRow (tableIndex: ${tableIndex}, rowIndex: ${rowIndex})`);
                            break;
                        }
                        Object.keys(data).forEach(colIndexStr => {
                            const colIndex = parseInt(colIndexStr, 10);
                            if (isNaN(colIndex)) return;
                            if (lockState.cols.has(colIndex)) return;
                            if (lockState.cells.has(`${rowIndex}:${colIndex}`)) return;
                            if (table.content[rowIndex + 1].length > colIndex + 1) {
                                table.content[rowIndex + 1][colIndex + 1] = data[colIndexStr];
                            }
                        });
                        if (isSummaryTable && sheetKey && isSpecialIndexLockEnabled_ACU(sheetKey)) {
                            const specialIndexCol = getSummaryIndexColumnIndex_ACU(table);
                            if (specialIndexCol >= 0) applySummaryIndexSequenceToTable_ACU(table, specialIndexCol);
                        }
                        logDebug_ACU(`Applied updateRow to table ${tableIndex} (${table.name}) at index ${rowIndex} with data:`, data);
                        appliedEdits++;
                        editCountsByTable[table.name] = (editCountsByTable[table.name] || 0) + 1;
                    }
                    break;
                }
            }
        } catch (e) {
            logError_ACU(`Failed to parse or apply command: "${line}"`, e);
        }
    });

    // 将统计信息写入表格对象
    Object.keys(editCountsByTable).forEach(tableName => {
        const sheetKey = Object.keys(currentJsonTableData_ACU).find(k => currentJsonTableData_ACU[k].name === tableName);
        if (sheetKey) {
            if (!currentJsonTableData_ACU[sheetKey]._lastUpdateStats) {
                currentJsonTableData_ACU[sheetKey]._lastUpdateStats = {};
            }
            currentJsonTableData_ACU[sheetKey]._lastUpdateStats.changes = editCountsByTable[tableName];
        }
    });
    
    // 收集所有被修改的表格 key
    const modifiedSheetKeys: string[] = [];
    Object.keys(editCountsByTable).forEach(tableName => {
        if (editCountsByTable[tableName] > 0) {
            const sheetKey = Object.keys(currentJsonTableData_ACU).find(k => currentJsonTableData_ACU[k].name === tableName);
            if (sheetKey) modifiedSheetKeys.push(sheetKey);
        }
    });
    
    return { success: true, modifiedKeys: modifiedSheetKeys, appliedEdits };
  }

  /**
   * 检测 <tableEdit> 内容是否为 SQL 语句
   * 跳过空行和注释行后，检查第一条非空行是否以 SQL 关键字开头
   */
  export function isSqlContent(content: string): boolean {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 跳过 SQL 注释
      if (trimmed.startsWith('--')) continue;
      // 跳过 HTML 注释残留
      if (trimmed.startsWith('<!--') || trimmed.startsWith('-->')) continue;
      // 检查是否以 SQL 关键字开头
      const sqlKeywords = /^(INSERT|UPDATE|DELETE|ALTER|BEGIN|CREATE|DROP|REPLACE)\b/i;
      return sqlKeywords.test(trimmed);
    }
    return false;
  }
