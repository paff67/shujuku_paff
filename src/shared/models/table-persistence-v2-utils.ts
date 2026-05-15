import type { TableLayerDeltaV2_ACU, TablePersistenceLayerV2_ACU } from './table-persistence-v2';

function cloneJson_ACU<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function isValidDeltaV2_ACU(delta: unknown): delta is TableLayerDeltaV2_ACU {
  return !!delta
    && typeof delta === 'object'
    && (delta as TableLayerDeltaV2_ACU).kind === 'delta'
    && (delta as TableLayerDeltaV2_ACU).version === 2
    && !!(delta as TableLayerDeltaV2_ACU).changesBySheet
    && typeof (delta as TableLayerDeltaV2_ACU).changesBySheet === 'object';
}

function hasAnyDeltaSheet_ACU(delta: TableLayerDeltaV2_ACU): boolean {
  if (delta.changesBySheet && Object.keys(delta.changesBySheet).some(key => key.startsWith('sheet_'))) {
    return true;
  }
  return Array.isArray(delta.changedSheets) && delta.changedSheets.some(key => typeof key === 'string' && key.startsWith('sheet_'));
}

function normalizeSequence_ACU(delta: TableLayerDeltaV2_ACU, fallbackSequence: number): TableLayerDeltaV2_ACU {
  const next = cloneJson_ACU(delta);
  if (!Number.isFinite(next.sequence)) {
    next.sequence = fallbackSequence;
  } else {
    next.sequence = Math.trunc(Number(next.sequence));
  }
  return next;
}

function sortDeltasBySequence_ACU(deltas: TableLayerDeltaV2_ACU[]): TableLayerDeltaV2_ACU[] {
  return deltas
    .map((delta, index) => ({ delta, index }))
    .sort((a, b) => {
      const seqA = Number.isFinite(a.delta.sequence) ? Number(a.delta.sequence) : a.index;
      const seqB = Number.isFinite(b.delta.sequence) ? Number(b.delta.sequence) : b.index;
      if (seqA !== seqB) return seqA - seqB;
      return a.index - b.index;
    })
    .map(entry => cloneJson_ACU(entry.delta));
}

export function getTablePersistenceDeltasV2_ACU(
  layer: TablePersistenceLayerV2_ACU | null | undefined,
): TableLayerDeltaV2_ACU[] {
  if (!layer || layer.version !== 2) return [];

  if (Array.isArray(layer.deltas) && layer.deltas.length > 0) {
    const normalized = layer.deltas
      .filter(isValidDeltaV2_ACU)
      .map((delta, index) => normalizeSequence_ACU(delta, index));
    return sortDeltasBySequence_ACU(normalized);
  }

  if (isValidDeltaV2_ACU(layer.delta)) {
    return [normalizeSequence_ACU(layer.delta, 0)];
  }

  return [];
}

export function hasTablePersistenceDeltasV2_ACU(
  layer: TablePersistenceLayerV2_ACU | null | undefined,
): boolean {
  return getTablePersistenceDeltasV2_ACU(layer).some(hasAnyDeltaSheet_ACU);
}

export function getLatestTablePersistenceDeltaV2_ACU(
  layer: TablePersistenceLayerV2_ACU | null | undefined,
): TableLayerDeltaV2_ACU | undefined {
  const deltas = getTablePersistenceDeltasV2_ACU(layer);
  return deltas.length > 0 ? cloneJson_ACU(deltas[deltas.length - 1]) : undefined;
}

export function appendTablePersistenceDeltaToLayerV2_ACU(
  existingLayer: TablePersistenceLayerV2_ACU | null | undefined,
  delta: TableLayerDeltaV2_ACU,
): TablePersistenceLayerV2_ACU {
  const baseLayer: TablePersistenceLayerV2_ACU = {
    version: 2,
    ...(existingLayer?.checkpoint ? { checkpoint: cloneJson_ACU(existingLayer.checkpoint) } : {}),
  };

  const existingDeltas = getTablePersistenceDeltasV2_ACU(existingLayer);
  const existingDeltaIndex = existingDeltas.findIndex(item => item.deltaId === delta.deltaId);

  let nextDeltas: TableLayerDeltaV2_ACU[];
  if (existingDeltaIndex >= 0) {
    nextDeltas = existingDeltas.map((item, index) => (
      index === existingDeltaIndex
        ? normalizeSequence_ACU(delta, item.sequence ?? index)
        : normalizeSequence_ACU(item, index)
    ));
  } else {
    const maxSequence = existingDeltas.reduce((max, item, index) => {
      const sequence = Number.isFinite(item.sequence) ? Number(item.sequence) : index;
      return Math.max(max, sequence);
    }, -1);
    nextDeltas = [
      ...existingDeltas.map((item, index) => normalizeSequence_ACU(item, index)),
      normalizeSequence_ACU(delta, maxSequence + 1),
    ];
  }

  nextDeltas = sortDeltasBySequence_ACU(nextDeltas);
  const latest = nextDeltas[nextDeltas.length - 1];

  return {
    ...baseLayer,
    delta: latest ? cloneJson_ACU(latest) : undefined,
    deltas: nextDeltas,
  };
}

function pruneDeltaSheetKeysV2_ACU(
  delta: TableLayerDeltaV2_ACU,
  sheetKeys: Set<string>,
): TableLayerDeltaV2_ACU | null {
  const next = cloneJson_ACU(delta);

  if (Array.isArray(next.changedSheets)) {
    next.changedSheets = next.changedSheets.filter(key => !sheetKeys.has(key));
  } else {
    next.changedSheets = [];
  }

  if (Array.isArray(next.modifiedKeys)) {
    next.modifiedKeys = next.modifiedKeys.filter(key => !sheetKeys.has(key));
  } else {
    next.modifiedKeys = [];
  }

  if (Array.isArray(next.updateGroupKeys)) {
    next.updateGroupKeys = next.updateGroupKeys.filter(key => !sheetKeys.has(key));
  } else {
    next.updateGroupKeys = [];
  }

  if (next.changesBySheet && typeof next.changesBySheet === 'object') {
    for (const sheetKey of sheetKeys) {
      delete next.changesBySheet[sheetKey];
    }
  } else {
    next.changesBySheet = {};
  }

  if (!hasAnyDeltaSheet_ACU(next)) {
    return null;
  }

  return next;
}

function hasCheckpointSheets_ACU(layer: TablePersistenceLayerV2_ACU): boolean {
  return !!layer.checkpoint?.data
    && typeof layer.checkpoint.data === 'object'
    && Object.keys(layer.checkpoint.data).some(key => key.startsWith('sheet_'));
}

export interface PruneTablePersistenceLayerSheetKeysResult_ACU {
  layer?: TablePersistenceLayerV2_ACU;
  changed: boolean;
}

export function pruneTablePersistenceLayerSheetKeysV2_ACU(
  layer: TablePersistenceLayerV2_ACU | null | undefined,
  sheetKeys: string[],
): PruneTablePersistenceLayerSheetKeysResult_ACU {
  if (!layer || layer.version !== 2 || !Array.isArray(sheetKeys) || sheetKeys.length === 0) {
    return { layer: layer ? cloneJson_ACU(layer) : undefined, changed: false };
  }

  const targetSheetKeys = new Set(sheetKeys.filter(key => typeof key === 'string' && key.startsWith('sheet_')));
  if (targetSheetKeys.size === 0) {
    return { layer: cloneJson_ACU(layer), changed: false };
  }

  const nextLayer: TablePersistenceLayerV2_ACU = cloneJson_ACU(layer);
  let changed = false;

  if (nextLayer.checkpoint?.data && typeof nextLayer.checkpoint.data === 'object') {
    for (const sheetKey of targetSheetKeys) {
      if ((nextLayer.checkpoint.data as Record<string, unknown>)[sheetKey] !== undefined) {
        delete (nextLayer.checkpoint.data as Record<string, unknown>)[sheetKey];
        changed = true;
      }
    }
  }

  const originalDeltas = getTablePersistenceDeltasV2_ACU(nextLayer);
  const prunedDeltas = originalDeltas
    .map(delta => pruneDeltaSheetKeysV2_ACU(delta, targetSheetKeys))
    .filter((delta): delta is TableLayerDeltaV2_ACU => !!delta);

  if (originalDeltas.length > 0) {
    const beforeIds = originalDeltas.map(delta => `${delta.deltaId}:${Object.keys(delta.changesBySheet || {}).sort().join(',')}`).join('|');
    const afterIds = prunedDeltas.map(delta => `${delta.deltaId}:${Object.keys(delta.changesBySheet || {}).sort().join(',')}`).join('|');
    if (beforeIds !== afterIds) changed = true;
  }

  if (prunedDeltas.length > 0) {
    const sorted = sortDeltasBySequence_ACU(prunedDeltas);
    nextLayer.deltas = sorted;
    nextLayer.delta = cloneJson_ACU(sorted[sorted.length - 1]);
  } else {
    delete nextLayer.deltas;
    delete nextLayer.delta;
  }

  if (!hasCheckpointSheets_ACU(nextLayer) && !hasTablePersistenceDeltasV2_ACU(nextLayer)) {
    return { changed: true, layer: undefined };
  }

  return { changed, layer: nextLayer };
}
