# loon-scripts

个人 Loon 脚本集合（cron 定时任务为主）。

## 脚本

| 脚本 | 说明 | 安装 |
| --- | --- | --- |
| `agentrouter-checkin.js` | [AgentRouter](https://agentrouter.org) 每日自动签到（账号密码登录即签到 + 日志核验） | [安装插件](https://raw.githubusercontent.com/cth123456/loon-scripts/main/AgentRouter.checkin.plugin) |
| `upstream-watch.js` | 每周检查上游 Python 脚本是否有未移植的新提交并提醒 | 随上面的插件一起安装 |

---

## AgentRouter 自动签到

由 [773075692/agentrouter-checkin](https://github.com/773075692/agentrouter-checkin)（青龙面板 Python 版）移植的 **Loon 版**。

### 原理

本站“签到” = **每日完成一次登录**：

1. 先 `GET /login` **预热会话**，拿到站点 WAF（阿里云，cookie 名 `acw_tc`）下发的 cookie；
2. `POST /api/user/login`，body `{"username": 邮箱, "password": 密码}`
   - 服务端下发 session cookie，`data.checked_in = true` 时发放当日额度
   - 登录响应 `data` 里直接带 `quota`（余额），无需额外查询
3. 登录成功后读取 `GET /api/log/self`（带请求头 `New-API-User: <uid>`），
   确认存在 `type=4`、内容含「签到成功」的当日日志，做一次端到端核验，
   避免「登录成功但签到未真正触发」。
4. 汇总所有账号结果，发一条 iOS 通知。

请求统一带浏览器风格的请求头（`Accept-Language`、`sec-ch-ua`、`Sec-Fetch-*` 等），并把预热得到的 cookie 显式回传——这两个都为了更接近正常浏览器会话、降低被 WAF 拦成 HTML 的概率。cookie 由脚本自己管理，**不依赖 Loon 的 `auto-cookie`**（那个需要 build 662+，本机是 build 81 用不了）。

账号密码固定，不存在第三方会话 cookie 过期问题；服务端按天去重，可放心每天重复运行。

### 出错时怎么排查

脚本会自动区分故障类型（最多重试 3 次，间隔 3s、6s）：

| 情况 | 脚本行为 |
| --- | --- |
| **阿里云 WAF 人机验证页** | **立即失败、不再重试**（重试只会加重风控），并提示改用直连 |
| HTTP 5xx（负载均衡/后端临时不可用） | 退避后重试；仍失败则报「服务端暂时不可用，请稍后重试」 |
| 其它 HTML（非人机验证的拦截页） | 重新预热会话再重试 |

失败时日志和通知会带上**HTTP 状态码、Content-Type、页面标题、正文片段**，
直接看这几项就能定位原因。

#### 遇到「需要人机验证」怎么办

如果日志出现 `检测到阿里云 WAF 人机验证页`，说明站点判定当前出口 IP 可疑，
弹出了**滑块/JS 人机验证**——这个必须由真人浏览器完成，任何脚本都过不了。

好消息是：**这种拦截通常是临时的、由访问频率触发**。实测在本机连续高频请求会触发，
停止请求后几分钟就自动解除，登录接口恢复正常。

处理顺序：

1. **把 `指定节点或策略组[可留空]` 填 `DIRECT`**（直连不走代理），点插件更新后手动触发一次。
   这是最常见的原因——Loon 若把该域名走了某个机房/共享代理节点，出口 IP 容易被 WAF 标记。
2. 若直连不通或太慢，改填你配置里另一个**干净节点**的策略组名（如 `HK`）。
3. 都还不行就**等几分钟**再试：这是频率触发的临时拦截，会自己解除。不要连续手动触发。

脚本检测到人机验证会立即停止并等下一个整点周期，就是为了避免"越试越黑"。


### 安装

**方式一：安装插件（推荐）**

在 Loon 中打开下面的链接即可安装插件，插件会创建两个定时任务（每小时签到 + 每周一检查上游）：

```
https://raw.githubusercontent.com/cth123456/loon-scripts/main/AgentRouter.checkin.plugin
```

安装后在插件详情页填入下面几项（**名字就是你在 Loon 里看到的标签**）：

| 插件里的名称 | 是否必填 | 填什么 |
| --- | --- | --- |
| `单账号[邮箱和密码]` | 单账号必填 | `邮箱#密码`，中间用英文 `#` 隔开 |
| `多账号[JSON数组]` | 多账号可选 | JSON 数组，见下；填了就优先用它 |
| `签到时间点[可留空]` | 可选 | 如 `9`、`9,15,21`、`9-18`；留空=每小时都签到 |
| `指定节点或策略组[可留空]` | 可选 | 如 `DIRECT`；遇人机验证时填这个（见「出错时怎么排查」） |
| `站点域名[可留空]` | 可选 | 默认 `https://agentrouter.org`，一般不用填 |

多账号示例（`多账号[JSON数组]`）：

```json
[{"name":"甲","account":"a@x.com#pwdA"},{"name":"乙","account":"b@x.com#pwdB"}]
```

也兼容旧格式：`[{"name":"甲","email":"a@x.com","password":"pwdA"}]`。

> **关于字段名**：Loon 旧式插件参数（`#!input`）没有单独的"说明"字段，括号里的名字本身就是显示给用户的标签，也是本地存储的键。所以这里直接用中文。
> 如果你之前装的是 v1.1.0 之前的版本、填的是英文键（`AGENTROUTER_ACCOUNT` 等），**升级后会继续读取旧值并自动迁移到中文键**，不用重填。
> 新版 Loon（build 733+）有带 `tag=` / `desc=` 的 `[Argument]` 段，能更好地区分"键名"和"显示名"，但本机 Loon 是 0.4.0 build 81，用不了，故仍用 `#!input` 中文标签方案。

### 时间与次数（cron 自定义）

默认是**每天 09:00 运行一次**（`cron "0 9 * * *"`）。

> 建议就保持默认。站点本身**按天去重**，一天签一次就够；而访问频次过高会被阿里云 WAF
> 判为机器人、弹人机验证（实测：连续高频请求就会触发）。所以默认从"每小时"改回了"每天一次"。

**想一天多次**：把插件里那行签到任务的 `cron "0 9 * * *"` 改成 `cron "0 * * * *"`（每小时唤醒），
再用 `签到时间点[可留空]` 指定具体几点真正执行：

| 签到时间点 | 效果（cron 为每小时时） |
| --- | --- |
| 留空 / 不填 | 每小时都签到（一天 24 次，不利风控，不建议） |
| `9` | 只在 09:00 签到（等价默认值） |
| `9,15,21` | 每天 9 / 15 / 21 点各一次 |
| `9-18` | 9 点到 18 点之间的整点各一次 |
| `22-2` | 支持跨午夜区间 |

不在列表里的小时，脚本会直接跳过并发一行日志，不发通知、不发请求。
注意：用的是 **Loon 运行设备上的本地时间**（通常就是北京时间）。

**要改 cron 本身的节奏**（每 30 分钟、隔天一次等）就改那行 cron：
格式是 `分 时 日 月 周`（五段），`0 9 * * *` 是每天 9 点、`0 * * * *` 是每小时、`*/30 * * * *` 是每 30 分钟、`0 9 * * 1,3,5` 是每周一三五 9 点。

**方式二：手动加定时脚本**

在配置的 `[Script]` 段加入：

```ini
cron "0 9 * * *" script-path=https://raw.githubusercontent.com/cth123456/loon-scripts/main/agentrouter-checkin.js, tag=AgentRouter签到, enable=true, timeout=120, argument = "邮箱#密码"
cron "0 10 * * 1" script-path=https://raw.githubusercontent.com/cth123456/loon-scripts/main/upstream-watch.js, tag=AgentRouter上游检查, enable=true, timeout=60
```

`argument` 支持单个 `邮箱#密码`，也支持直接填账号 JSON 数组。
优先级：`argument` > `多账号[JSON数组]` > `单账号[邮箱和密码]`。
只用 `argument` 时无法配置 `签到时间点`（那是插件输入项），需要限时请走插件方式。

### 跟随上游 Python 更新

上游 `agentrouter_checkin.py` 是用 Python 写的，Loon 只能跑 JavaScript，**没有办法直接执行或自动翻译它**。所以"跟随更新"做成了带提醒的半自动流程：

1. `upstream-watch.js` 每周一 10:00 检查上游有没有新提交；
2. 一旦发现我们还没移植的提交，就发一条 iOS 通知，带上提交信息、时间、以及和当前版本的**对比链接**；
3. 你按下面的「重新移植」步骤把改动搬进 JS；
4. 改完更新 `upstream-baseline.json` 的 `ported_sha`，下个周期自动对齐，不再重复提醒。

**判定基准**是 `upstream-baseline.json` 的 `ported_sha`——记录我们已移植到哪个上游提交。当前基准：`88d5f1e`（2026-08-04）。

**重新移植步骤**：

```bash
# 1. 看上游改了什么
#    打开通知里的 compare 链接，或本地：
git clone https://github.com/773075692/agentrouter-checkin /tmp/ar-upstream
cd /tmp/ar-upstream && git log --oneline -5

# 2. 把改动搬进 agentrouter-checkin.js（改逻辑、接口路径、字段名等）

# 3. 更新基准，把 ported_sha 换成上游最新提交的完整 SHA
#    取 SHA：git -C /tmp/ar-upstream rev-parse HEAD

# 4. 递增 agentrouter-checkin.js 的 SCRIPT_VERSION、跑测试、提交推送
cd /Users/mac/Documents/Codex/loon-scripts
node test/smoke.js
git add -A && git commit -m "port upstream <short-sha>" && git push
```

检查脚本用的是 GitHub 的 commits **Atom feed**（`github.com/<repo>/commits/main/agentrouter_checkin.py.atom`），而不是 REST API——因为未认证的 REST API 按 IP 限速（共享出口/VPN 很容易 403），Atom feed 没有这个限制。

### 安全说明

- `AGENTROUTER_BASE_URL` 只允许 `http`/`https`，并拒绝 `localhost`、环回、私网（`10/8`、`172.16/12`、`192.168/16`、`100.64/10`）与保留地址，防止把账号密码发到本机或内网地址。
- 账号密码只保存在 Loon 本地（`$persistentStore`），不会打进脚本或发往任何第三方。
- 仓库内不含任何真实账号信息。

### 本地开发

```bash
node --check agentrouter-checkin.js   # 语法检查
node --check upstream-watch.js
node test/smoke.js                     # 105 项逻辑 + 安全性 + 时间控制 + 重试/人机验证/兼容测试（stub 掉 Loon 运行时，不发真实请求）
```

两个脚本都在文件末尾判断了运行环境：在 Loon 中自动执行，被 Node `require` 时只导出函数，便于本地测试。

### 更新机制（重要）

脚本和插件都由 `main` 分支的 **raw 链接**提供，所以更新分两层：

1. **脚本本体**：只要本仓库 `main` 分支的 `agentrouter-checkin.js` 有改动，Loon 下一次运行时拉到的就是新版——**不需要重装插件**。
   不过 `raw.githubusercontent.com` 有约 **5 分钟** CDN 缓存（`cache-control: max-age=300`），刚推送后短时间内可能还拿到旧内容。
2. **插件本体**：`AgentRouter.checkin.plugin`（定时时间、输入项、tag 等）若改动，需要在 Loon 里对这条插件做一次「更新」才会生效。

**怎么确认当前跑的是哪一版**：脚本每次运行会在 Loon 日志里打印
`AgentRouter 自动签到启动 (Loon) v<版本号>`；插件描述里也带同一个版本号。
怀疑没更新时，手动触发一次脚本，看这行输出即可。

> 说明：上面第 1、2 点基于 Loon 官方手册「远程 script-path 按 URL 拉取」与 GitHub raw 的实测缓存头（`max-age=300`）得出；Loon 客户端内具体是自动轮询还是需手动「更新」，官方没有公开文档，未在本机真机上实测。稳妥做法：更新插件后手动触发脚本一次，看版本号。

### 说明 / 与原版的差异

- 原版依赖青龙的 `notify` 模块，Loon 版改用 `$notification.post`。
- 原版的代理、强制 IPv4 环境变量在 Loon 中由 App 自身的网络设置处理，未移植。
- 原版的 `AGENTROUTER_BASE_URL` 环境变量在 Loon 版对应插件输入项（同样的名字）。
- 备用域名 `ps.air-outer.com` 功能一致，可通过「站点域名[可留空]」切换。

### 已知限制

- 本脚本为 cron 定时类型，依赖 App 打开的定时执行机制；iOS 上建议配合 Loon 的后台定时权限使用。
- 逻辑与安全性用 Node stub + 真实站点请求验证过（登录接口能拿到正常 JSON）；但**没有有效账号**，所以「签到成功 → 发额度 → 日志确认」这条完整成功路径未在真机跑通。首次使用建议先手动触发一次，看通知与日志。
- 站点在阿里云 WAF 后，**出口 IP 触发风控时会弹人机验证**（脚本无法通过）。实测该拦截是临时的、由访问频率触发，停止请求几分钟后自动解除；已在插件里提供「指定节点或策略组」用于换出口。
