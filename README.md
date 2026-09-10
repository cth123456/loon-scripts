# loon-scripts

AgentRouter 自动签到 Loon 插件。

脚本本体来自 **[ddgksf2013/Scripts](https://github.com/ddgksf2013/Scripts/blob/master/agentrouter_checkin.js)**（仓库里只保存插件包装，直接引用原作者脚本地址，作者更新自动同步）。原理：账号密码登录即签到，登录后回查个人日志确认，并查询账户余额。

## 安装

Loon 中打开：

```
https://raw.githubusercontent.com/cth123456/loon-scripts/main/AgentRouter.plugin
```

## 配置

安装后在插件配置里填：

| 输入项 | 说明 |
| --- | --- |
| `AGENTROUTER_ACCOUNT` | 单账号：`邮箱#密码` |
| `AGENTROUTER_ACCOUNTS` | 多账号（可选）：`[{"name":"甲","account":"a@x.com#pwdA"}]` |

## 调度与自定义运行时间

默认 **每天 3、5、10 点**自动执行；点击运行按钮可立即执行。

想改时间，两种方式：

1. **Loon 内直接改（推荐，3.5.x 支持）**：脚本页 → 点「AgentRouter签到」→ 修改 cron。只影响本机，插件更新不丢失。
2. **改仓库一行（影响所有设备）**：插件文件里只有一行 cron，改完推送到仓库，各设备更新插件后同步生效。cron 格式：`分 时 日 月 周`，例：`0 9 * * *` 每天上午 9 点、`0 */6 * * *` 每 6 小时。

## 跟随上游更新

插件里的 `script-path` 直接指向 **ddgksf2013 仓库 master 分支的脚本地址**，Loon 每次运行都会拉取最新版——原作者的修复和改进自动同步到你设备，无需任何操作。本仓库只保存插件包装（定时调度 + 输入项），不复制脚本本体。

## 说明

- 脚本仓库不含任何账号信息；账号只保存在 Loon 本地。
- 若站点弹人机验证，到浏览器完成一次验证后再试。
- 本插件仅为包装与定时调度，脚本版权归属原作者 ddgksf2013。
