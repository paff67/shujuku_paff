export const plotCopy = {
  panels: {
    preset: {
      title: "剧情推进预设",
      description:
        "下拉框切换当前的预设，星标设为全局默认。点击按钮，可导入新预设、管理全部预设。内置默认预设无法修改，请使用「从默认新建」。预设包含多个独立任务，支持并发或串行。",
    },
    worldbook: {
      title: "剧情推进世界书",
      description:
        "剧情推进参考的世界书条目。默认跟随角色卡主世界书，也可手动指定。与填表世界书独立。",
    },
  },
  worldbook: {
    emptyDefault: "所选世界书中无可显示的条目。",
    emptyCharacter:
      "未解析到角色卡世界书。打开聊天后会显示条目；也可手动选择一本。",
    emptyManual: "请先选择一本世界书。",
  },
};
