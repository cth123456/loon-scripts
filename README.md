# loon-scripts

个人 Loon 脚本集合（cron 定时任务为主）。

## 脚本

| 脚本 | 说明 | 安装 |
| --- | --- | --- |
| `agentrouter-checkin.js` | [AgentRouter](https://agentrouter.org) 每日自动签到（账号密码登录即签到 + 日志核验） | [安装插件](https://raw.githubusercontent.com/cth123456/loon-scripts/main/AgentRouter.checkin.plugin) |

---

## AgentRouter 自动签到

由 [773075692/agentrouter-checkin](https://github.com/773075692/agentrouter-checkin)（青龙面板 Python 版）移植的 **Loon 版**。

### 原理

本站“签到” = **每日完成一次登录**：

1. `POST /api/user/login`，body `{"username": 邮箱, "password": 密码}`
   - 服务端下发 session cookie，`data.checked_in = true` 时发放当日额度
   - 登录响应 `data` 里直接带 `quota`（余额），无需额外查询
2. 登录成功后读取 `GET /api/log/self`（带请求头 `New-API-User: <uid>`），
   确认存在 `type=4`、内容含「签到成功」的当日日志，做一次端到端核验，
   避免「登录成功但签到未真正触发」。
3. 汇总所有账号结果，发一条 iOS 通知。

账号密码固定，不存在第三方会话 cookie 过期问题；服务端按天去重，可放心每天重复运行。

### 安装

**方式一：安装插件（推荐）**

在 Loon 中打开下面的链接即可安装插件，插件会创建每天 09:00 的定时任务：

```
https://raw.githubusercontent.com/cth123456/loon-scripts/main/AgentRouter.checkin.plugin
```

安装后在插件配置页面填入：

| 输入项 | 是否必填 | 说明 |
| --- | --- | --- |
| `AGENTROUTER_ACCOUNT` | 单账号必填 | 格式 `邮箱#密码` |
| `AGENTROUTER_ACCOUNTS` | 多账号可选 | JSON 数组，见下 |
| `AGENTROUTER_BASE_URL` | 可选 | 覆盖站点域名，默认 `https://agentrouter.org` |

多账号示例（`AGENTROUTER_ACCOUNTS`）：

```json
[{"name":"甲","account":"a@x.com#pwdA"},{"name":"乙","account":"b@x.com#pwdB"}]
```

也兼容旧格式：`[{"name":"甲","email":"a@x.com","password":"pwdA"}]`。
设置了 `AGENTROUTER_ACCOUNTS` 时优先使用它。

**方式二：手动加定时脚本**

在配置的 `[Script]` 段加入：

```ini
cron "0 9 * * *" script-path=https://raw.githubusercontent.com/cth123456/loon-scripts/main/agentrouter-checkin.js, tag=AgentRouter签到, enable=true, timeout=60, argument = "邮箱#密码"
```

`argument` 支持单个 `邮箱#密码`，也支持直接填账号 JSON 数组。
优先级：`argument` > `AGENTROUTER_ACCOUNTS` > `AGENTROUTER_ACCOUNT`。

### 安全说明

- `AGENTROUTER_BASE_URL` 只允许 `http`/`https`，并拒绝 `localhost`、环回、私网（`10/8`、`172.16/12`、`192.168/16`、`100.64/10`）与保留地址，防止把账号密码发到本机或内网地址。
- 账号密码只保存在 Loon 本地（`$persistentStore`），不会打进脚本或发往任何第三方。
- 仓库内不含任何真实账号信息。

### 本地开发

```bash
node --check agentrouter-checkin.js   # 语法检查
node test/smoke.js                     # 37 项逻辑 + 安全性测试（stub 掉 Loon 运行时，不发真实请求）
```

`agentrouter-checkin.js` 在文件末尾判断了运行环境：在 Loon 中自动执行，被 Node `require` 时只导出函数，便于本地测试。

### 说明 / 与原版的差异

- 原版依赖青龙的 `notify` 模块，Loon 版改用 `$notification.post`。
- 原版的代理、强制 IPv4 环境变量在 Loon 中由 App 自身的网络设置处理，未移植。
- 原版的 `AGENTROUTER_BASE_URL` 环境变量在 Loon 版对应插件输入项（同样的名字）。
- 备用域名 `ps.air-outer.com` 功能一致，可通过 `AGENTROUTER_BASE_URL` 切换。

### 已知限制

- 本脚本为 cron 定时类型，依赖 App 打开的定时执行机制；iOS 上建议配合 Loon 的后台定时权限使用。
- 仅在 macOS 上用 Node stub 验证过逻辑与安全性；未在真机 Loon 上跑过完整签到（缺少有效账号）。首次使用建议先手动触发一次，看通知与日志。
