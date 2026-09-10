# loon-scripts

个人 Loon 脚本集合。当前 AgentRouter 版本：**1.5.0**。

| 脚本 | 说明 |
| --- | --- |
| `agentrouter-checkin.js` | 账号密码登录签到，并查询个人日志核验 |
| `upstream-watch.js` | 每周检查上游 Python 脚本是否有尚未移植的新提交 |

## 安装与输入

主插件地址：

```text
https://raw.githubusercontent.com/cth123456/loon-scripts/main/AgentRouter.checkin.plugin
```

安装后创建每小时签到 cron、独立手动 generic、每周一 10 点上游检查任务。升级时需要更新**插件和脚本**，只更新 JS 不会改变旧 cron 或增加输入项、手动入口。不要同时启用两份签到插件，否则可能重复执行。

| 插件中文标签 | 填写说明 |
| --- | --- |
| `单账号[邮箱]` | 新单账号邮箱，与密码分开输入 |
| `单账号[密码]` | 密码原样传递，支持 `#` 及首尾空格 |
| `单账号[邮箱和密码]` | 仅为旧配置兼容保留，新用户留空；旧格式为 `邮箱#密码`，按第一个 `#` 分隔 |
| `多账号[JSON数组]` | 可选，优先于单账号，格式见下 |
| `签到时间点[可留空]` | 如 `3,5,10`；保留旧值，不自动改写 |
| `指定节点或策略组[可留空]` | 可选，原样作为请求的 `node` 参数；`DIRECT` 表示直连，不保证能解决验证或网络问题 |
| `站点域名[可留空]` | 默认 `https://agentrouter.org`；只填写自己确认可信的站点 |

多账号支持两种格式：

```json
[{"name":"甲","account":"a@example.com#pwdA"},{"name":"乙","email":"b@example.com","password":"pwdB"}]
```

配置优先级：旧凭据 `argument` > 多账号 JSON > 分开的单账号邮箱与密码 > 旧单账号组合字段。新单账号任一字段非空时必须两项同时填写，不会悄悄回退到旧账号。旧英文 `AGENTROUTER_ACCOUNT`、`AGENTROUTER_ACCOUNTS`、`AGENTROUTER_BASE_URL`、`AGENTROUTER_RUN_HOURS` 仍兼容读取并迁移到对应旧中文键。

`argument="manual"` 和 `argument="scheduled"` 是运行模式，不会作为账号解析；旧 `邮箱#密码` 或 JSON argument 仍能使用，且维持小时过滤。分开输入支持邮箱或密码本身包含 `#`；旧组合格式不能无歧义表达含 `#` 的邮箱。

## 定时与手动运行

- **定时入口**：`cron "0 * * * *"` 每小时唤起，`argument="scheduled"` 根据设备本地小时检查 `签到时间点[可留空]`。不匹配时不发请求、不发通知。
- **手动入口**：在 Loon 内手动触发 **AgentRouter手动签到**（generic，`argument="manual"`），无论几点都绕过小时过滤；仍执行凭据、安全和预算检查。
- **点击 cron 自带的运行按钮仍是定时入口**：argument 不会因此改变，仍受小时过滤。不能用它验证“手动绕过”。

例如填 `3,5,10`，自动在本地 03:00、05:00、10:00 执行；18 点自动或手动点击 cron 会跳过，18 点触发独立 generic 会立即执行。

| 小时配置 | 定时行为 |
| --- | --- |
| `3,5,10` | 只在 3、5、10 点执行 |
| `9` | 每天 9 点执行，建议只需每日签到时使用 |
| `9-18` | 9 到 18 点的整点 |
| `22-2` | 跨午夜 22、23、0、1、2 点 |
| 留空 | 保留历史语义，每小时执行；不会自动填入默认小时 |

解析器保留原有行为：忽略非法片段；若全部非法，结果与留空相同，不做小时限制。请核对输入，避免不必要的频繁请求。系统休眠、后台调度等可能影响实际执行；脚本不补跑错过的小时。

### 官方 API 核实与边界

2026-09-10 查阅 Loon 官方文档：

- [脚本配置](https://nsloon.app/docs/Script/)：cron、generic 和 `argument="..."` 语法；generic 在 App 内手动触发；脚本行 timeout 单位为秒。
- [Script API](https://nsloon.app/docs/Script/script_api)：`$argument`、`$script.name`、`$script.startTime`，以及 `$environment.params` 的节点/策略上下文；HTTP timeout 单位为毫秒。
- [官方仓库脚本类型示例](https://github.com/Loon0x00/LoonExampleConfig/blob/master/Script/script_README.md)：generic 手动入口及 cron 示例。

上述文档**未提供可靠识别“手动点击 cron / 自动 cron”的字段**，所以本项目显式区分入口参数，不编造 `$environment` 运行类型，也不按脚本名猜测。

沿用旧式 `#!input` 中文标签，名称同时是本地存储键。不同平台的 build 编号不能直接比较，**不能仅凭 Mac build 81 与 iOS build 662/733 的数字大小断言特性不可用**。本版本未在用户的 Loon 真机上验证 generic 展示位置、参数传递和客户端版本兼容性。

如自行配置，以下两行读取已保存的插件输入；没有保存凭据时不会登录：

```ini
[Script]
cron "0 * * * *" script-path=https://raw.githubusercontent.com/cth123456/loon-scripts/main/agentrouter-checkin.js, tag=AgentRouter签到, enable=true, timeout=120, argument="scheduled"
generic script-path=https://raw.githubusercontent.com/cth123456/loon-scripts/main/agentrouter-checkin.js, tag=AgentRouter手动签到, timeout=120, argument="manual"
```

## 登录、重试与安全边界

1. `GET /login` 预热会话，提取响应 Cookie。
2. `POST /api/user/login` 提交账号密码。每账号每轮**最多 10 次 POST（包含首次，不是额外重试 10 次）**。
3. 成功响应立即停止登录 POST；若 `data.checked_in=true`，查询一次 `/api/log/self`，携带 `New-API-User` 与合并后的 Cookie。日志查询失败或 `checked_in=false` 不会再次登录。
4. 汇总通知。登录成功不等于已验证发放额度，以服务端响应和日志为准。现有日志判定使用近 24 小时窗口，而非严格的本地自然日。

| 情况 | 行为 |
| --- | --- |
| 网络错误（HTTP 客户端已回调）、HTTP 5xx | 间隔 3 秒后重试，受次数和预算双重限制 |
| 2xx HTML，未识别出验证特征 | 间隔 3 秒重试，沿用并合并已有 Cookie，不重复预热 |
| 明确凭据错误、账号受限 | 立即停止，不反复试密码 |
| 已识别验证码/人机验证（预热或登录响应，包括 JSON 错误消息） | 立即停止，不自动解验证码、不绕过挑战 |
| HTTP 401/403/429 | 停止，避免反复认证或加重限流 |
| 未知业务失败、其他非 JSON 响应 | 保守停止，不把所有失败都当作可恢复错误 |

预算：单请求最多 **10 秒**，每账号含预热、退避及日志查询最多 **90 秒**；所有账号共享 **110 秒**整轮预算，插件 timeout 为 **120 秒**。预算不足会提前停止，因此不是保证每次都发满 10 次。多账号顺序执行，后面的账号可能因整轮预算不足而未执行，通知会说明。客户端回调未返回时由脚本 watchdog 结束等待；没有可靠的底层请求取消 API，因此此情况停止本账号、不继续重试，迟到回调被忽略。不要同时触发多个入口；当前没有跨运行锁，预算和次数按各次运行分别计算。

Cookie 在单账号本轮内按名称合并，同名新值覆盖，未更新的 WAF/session Cookie 保留，不依赖 `auto-cookie`。这不是完整浏览器 Cookie jar，不解析 Domain/Path/Expires 的完整作用域语义；仅供该站点本轮会话使用，不跨账号缓存。

遇到人机验证，请按站点官方页面指引处理并减少频繁触发。仅凭拦截页无法确定是 IP、频率还是其他原因；不保证换出口、DIRECT 或等待几分钟就解除。脚本识别依赖已知特征，不能保证识别所有挑战变体。

- 凭据存储于 Loon 本地并提交给配置的站点；不要分享带凭据的配置，不要把凭据、Cookie 写入仓库。
- `站点域名` 保留既有 http/https 与部分本机/私网地址检查，不是完整 DNS/重定向安全隔离；请使用可信 HTTPS 域名，不要向不可信自定义站点提交密码。
- 错误响应正文不输出，避免服务端回显秘密；通知可能包含用户名和额度，分享日志前仍应检查。
- 本次开发未更改用户系统配置或 GPT 路由，未进行真实网络登录测试。

## 跟随上游 Python 更新

来源：[773075692/agentrouter-checkin](https://github.com/773075692/agentrouter-checkin)。Loon 不能直接运行 Python，需要人工移植 JavaScript。

`upstream-watch.js` 每周一 10:00 读取 GitHub commits Atom feed，与 `upstream-baseline.json` 的 `ported_sha` 对比，有新提交时通知并提供比较链接。当前移植基准 `88d5f1e`（2026-08-04）。Atom feed 仍可能因网络或服务限制失败，不保证不受限流。

重新移植时查看上游差异、修改 JS 和基准文件、递增版本号、同步插件并运行离线测试；提交发布应另行明确授权。

## 本地验证与更新

```bash
node --check agentrouter-checkin.js
node --check upstream-watch.js
node --check test/smoke.js
node test/smoke.js
```

测试 stub 掉 Loon HTTP、存储、通知、时钟，不发真实请求。覆盖成功路径、手动/定时小时过滤、分开及旧凭据、重试上限、停止条件、Cookie 合并与预算，以及原有上游检查用例。

更新插件后，运行 **AgentRouter手动签到**，查看日志 `AgentRouter 自动签到启动 (Loon) v1.5.0`。远程脚本及客户端缓存可能延迟更新，不承诺每次执行都实时下载新版；必要时使用客户端更新操作再核对版本。本地代码未发布前，远程 main 链接不会包含本次修改。

已有镜像插件仅同步功能配置，不作为本次安装推荐；其缓存时效不作未经核实的固定时长承诺。

## 已知限制

- 本次仅完成离线逻辑验证，未验证真机“登录 → 额度发放 → 日志确认”全链路。
- 没有可靠的内建手动 cron 检测；必须使用独立 generic 才能绕过小时过滤。
- 不提供验证码绕过、无限重试或网络可达性保证。
