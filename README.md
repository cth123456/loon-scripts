# loon-scripts

个人 Loon 远程规则与插件。仓库只发布公开规则和插件包装，不保存账号、订阅密钥或设备配置。

## Apple Intelligence / Siri 远程规则

按截图的 17 项域名整理，包含 Siri、Apple Intelligence / Private Cloud Compute、iCloud Private Relay，以及截图列出的定位和资源域名。纯分流规则，不含 MITM、脚本或重写。

引用地址：

```text
https://raw.githubusercontent.com/cth123456/loon-scripts/main/AppleIntelligence.list
```

### 在 Loon 添加

1. 打开「配置 → 规则 → 订阅规则」（部分版本显示为「远程规则」），新增上面的链接，名称可填 `Apple Intelligence`。
2. 策略选择你已有的、能访问相关服务的代理节点或策略组，例如美国节点；**不要选 DIRECT**。需要 Private Cloud Compute / Private Relay 时，节点还应支持 UDP/QUIC。
3. 将它排在宽泛的 Apple、iCloud、国内直连和兜底规则之前，更新并启用。若本地规则或插件规则更早命中，还需要检查请求记录中的实际匹配。

也可在已有配置的 `[Remote Rule]` 段添加以下一行。`你的代理策略组` 必须替换为配置中真实存在的名称；不要重复创建该配置段。

```ini
https://raw.githubusercontent.com/cth123456/loon-scripts/main/AppleIntelligence.list, policy=你的代理策略组, tag=Apple Intelligence, enabled=true
```

### 范围与限制

- 已补全完整域名：`apple-dns` 使用 `.net`，其他截图条目使用 `.com`；图中易混淆的 `gspel` 校正为 `gspe1-ssl.ls.apple.com`（数字 `1`）。
- 17 条规则中，`ls.apple.com`、`smoot.apple.com`、`mask-h2.icloud.com`、`mask.icloud.com` 使用后缀匹配，其余为精确域名匹配。保留 `gspe1-ssl.ls.apple.com` 显式条目便于对照截图，它也被 `ls.apple.com` 后缀覆盖。
- 为忠实于截图，包含 `ls.apple.com` 和 `apps.mzstatic.com`，会让相关定位/地图及 App 资源流量也走所选代理；这不是仅含 AI 请求的最小规则集。没有把整个 `apple.com`、`icloud.com` 或 `cloudflare.com` 交给代理。
- 只改变连接走向，**不保证解锁 Apple Intelligence**。设备型号、销售地区、Apple 账号、系统与语言支持、出口地区及服务端限制仍可能影响功能。
- 不需要安装证书或开启 HTTPS 解密。静态语法与链接下载验证不能替代 iPhone 上的实际 Siri / Apple Intelligence 测试。

核对来源：[Apple 企业网络端点说明](https://support.apple.com/en-us/101555)、[blackmatrix7 的 Loon iCloudPrivateRelay 域名表](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Loon/iCloudPrivateRelay)。本文件按截图独立整理，只参考公开域名事实，不复制上游脚本。

## EOOS 每日签到插件

脚本按 `eoos.top` 前端实际接口编写：账号密码登录拿 token → 查询签到状态 → Cap 工作量证明验证 → 提交签到。登录和签名的令牌会自动缓存，失效时自动重新登录，不需要手动抓 token。

```
https://raw.githubusercontent.com/cth123456/loon-scripts/main/EOOS.plugin
```

### 输入项

| 插件中文标签 | 填写说明 |
| --- | --- |
| `单账号[用户名或邮箱]` | 站点登录账号 |
| `单账号[密码]` | 站点密码，原样保存，支持首尾空格 |
| `签到时间点[可留空]` | 如 `9`、`8,20`、`7-9`、`22-2`；留空则每小时执行 |
| `指定节点或策略组[可留空]` | 默认 `DIRECT`；填写后走该节点，证书校验失败会自动退回 DIRECT |

### 定时与手动运行

- **定时入口**：`cron "0 * * * *"` 每小时唤起，仅在设备本地小时命中「签到时间点」时签到；不匹配时不发请求、不发通知。
- **手动入口**：运行「EOOS手动签到」立即签到，绕过时间点限制。
- 点击 cron 项自带的运行按钮仍走定时入口，保留小时过滤。

### 说明

- 签到验证是本地计算的 SHA-256 工作量证明（当前 18 组、4 位前缀），不是图片验证码；`timeout` 为 120 秒。
- 请求默认 `DIRECT`，避免代理节点或 MITM 带来的证书链问题；确需走代理时填「指定节点或策略组」。
- 若出现 `certificate verify failed`：脚本会用 `api.github.com` 做对照探测，区分「Loon 全局信任链异常」和「仅本站失败」，并在通知里给出处理建议；不会跳过证书校验发送账号密码。
- 仓库与脚本均不含任何账号、令牌或 Cookie；凭据只保存在 Loon 本地。
- 系统休眠或后台调度可能影响实际执行，脚本不补跑错过的小时。

## AgentRouter 自动签到插件

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
