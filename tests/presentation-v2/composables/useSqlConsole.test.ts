/**
 * useSqlConsole.test — SQL 控制台 composable
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function mockSqlConsoleDeps(opts: {
  sqlite?: boolean;
  queryResult?: { columns: string[]; values: any[][]; rowCount: number };
  mutationResult?: { changes: number; errors: string[] };
  queryError?: Error;
}) {
  const executeQuery = vi.fn(() => {
    if (opts.queryError) throw opts.queryError;
    return opts.queryResult ?? { columns: ['name'], values: [['items']], rowCount: 1 };
  });
  const executeMutation = vi.fn(() => opts.mutationResult ?? { changes: 2, errors: [] });
  const getStorageProvider = vi.fn(() => ({
    executeQuery,
    executeMutation,
  }));

  vi.doMock('../../../src/service/table/storage-mode', () => ({
    isSqliteMode: () => opts.sqlite !== false,
  }));
  vi.doMock('../../../src/service/table/table-storage-strategy', () => ({
    getStorageProvider,
  }));
  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: { toastMuteEnabled: false },
  }));

  return { executeQuery, executeMutation, getStorageProvider };
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('useSqlConsole', () => {
  async function freshFlow() {
    const [{ createPinia, setActivePinia }, { useSqlConsole, __resetSqlConsoleHistoryForTests }, { useToastStore }] =
      await Promise.all([
        import('pinia'),
        import('../../../src/presentation-v2/composables/useSqlConsole'),
        import('../../../src/presentation-v2/stores/toast-store'),
      ]);
    setActivePinia(createPinia());
    __resetSqlConsoleHistoryForTests();
    return { flow: useSqlConsole(), toast: useToastStore() };
  }

  it('空 SQL 不调用 provider，并提示 warning', async () => {
    const deps = mockSqlConsoleDeps({});
    const { flow, toast } = await freshFlow();
    flow.executeCurrent();

    expect(deps.getStorageProvider).not.toHaveBeenCalled();
    expect(toast.items.at(-1)).toMatchObject({ kind: 'warning' });
    expect(flow.history.value).toHaveLength(0);
  });

  it('执行 SELECT 查询后写入查询结果和成功历史', async () => {
    const deps = mockSqlConsoleDeps({
      queryResult: {
        columns: ['id', 'name'],
        values: [[1, 'Potion']],
        rowCount: 1,
      },
    });
    const { flow } = await freshFlow();
    flow.sqlText.value = 'SELECT id, name FROM item;';
    flow.executeCurrent();

    expect(deps.executeQuery).toHaveBeenCalledWith('SELECT id, name FROM item;');
    expect(flow.result.value.kind).toBe('query');
    expect(flow.result.value.columns).toEqual(['id', 'name']);
    expect(flow.result.value.values).toEqual([[1, 'Potion']]);
    expect(flow.history.value[0]).toMatchObject({ sql: 'SELECT id, name FROM item;', success: true });
    expect(flow.statusKind.value).toBe('success');
  });

  it('执行变更语句失败时写入错误结果和失败历史', async () => {
    const deps = mockSqlConsoleDeps({
      mutationResult: { changes: 0, errors: ['no such table: item'] },
    });
    const { flow, toast } = await freshFlow();
    flow.sqlText.value = "UPDATE item SET name = 'x';";
    flow.executeCurrent();

    expect(deps.executeMutation).toHaveBeenCalledWith("UPDATE item SET name = 'x';");
    expect(flow.result.value.kind).toBe('error');
    expect(flow.result.value.error).toContain('no such table');
    expect(flow.history.value[0]).toMatchObject({ success: false });
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('非 SQLite 模式下拒绝执行', async () => {
    const deps = mockSqlConsoleDeps({ sqlite: false });
    const { flow } = await freshFlow();
    flow.sqlText.value = 'SELECT 1;';
    flow.executeCurrent();

    expect(deps.getStorageProvider).not.toHaveBeenCalled();
    expect(flow.result.value.kind).toBe('error');
    expect(flow.result.value.error).toContain('SQLite 模式');
    expect(flow.history.value).toHaveLength(0);
  });
});
