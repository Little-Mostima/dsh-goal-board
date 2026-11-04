# dsh-goal-board

DeepSeek Harness 的「目标清单」插件：给人和 agent 共用一块看板，按 **项目 → 目标 → 条目** 三层组织，每轮把当前工作注入给 agent，任务做完由 agent 核对产出后自动归档。

## 安装

在 DSH 里添加插件，指向本仓库：

```
dsh plugin add github:Little-Mostima/dsh-goal-board
```

装好重启桌面端。清单数据落在 `.dsh\goal-board\data.json`，卸载插件不会删它。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 服务端：`goal_board_update` 工具、每轮注入、HTTP API、过期认领自动释放与自动归档 |
| `client.js` | 面板界面（Web 平台客户端插件）：卡片拖动换区、认领徽章、备注折叠 |
| `cordis.patch.yml` | 插件管理器的挂载清单 |
| `smoke.test.mjs` | 自测：临时 DSH_HOME 跑假 ctx，14 项断言，不碰真实清单 |
| `locale/` | 界面文案 |
| `icon.svg` | 图标 |

## 行为要点

- 认领带心跳，30 分钟没动静自动释放，卡片回到「排队中」，不用人点（`DSH_GOAL_BOARD_TTL_MS` 可改，调试用）。
- 目标做完由 agent 核对产出、填产出指针后归档并从清单移除；面板不再有「已完成」区。
- 会话登记最近 2 小时的活动：清单里没有卡的会话，每轮注入会点名，面板也会提示，防止「干了很久但没有记录」。

## 数据不在这个仓库里

清单实体在 `.dsh\goal-board\data.json`（`data.backup-*.json` 是同目录备份），由插件启动时读入、内存维护、变更即落盘。升级/回滚代码不影响数据。

## 自测

```powershell
node smoke.test.mjs
```

## 改动生效

服务端（`index.js`）和面板（`client.js`）都不热重载，改完要重启桌面端。
