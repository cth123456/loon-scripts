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

## 调度

每天 **3、5、10 点**自动执行；点击运行按钮可立即执行。修改节奏直接改插件里的 cron 行。

## 说明

- 脚本仓库不含任何账号信息；账号只保存在 Loon 本地。
- 若站点弹人机验证，到浏览器完成一次验证后再试。
- 本插件仅为包装与定时调度，脚本版权归属原作者 ddgksf2013。
