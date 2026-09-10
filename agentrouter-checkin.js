/* eslint-disable */
/**
 * AgentRouter 自动签到 —— Loon 版（单一 cron 入口，可手动运行）
 *
 * 原理：本站"签到"= 每日完成一次登录。
 *   1) POST /api/user/login {username: 邮箱, password: 密码}
 *      -> 服务端下发 session cookie，data.checked_in = true 时发放当日额度，
 *         登录响应 data 里直接带 quota（余额）。
 *   2) 登录成功后读取 /api/log/self 个人日志，确认存在 type=4、内容含"签到成功"
 *      的当日记录，做一次端到端核验，避免"登录成功但签到未真正触发"。
 *
 * 移植自：https://github.com/773075692/agentrouter-checkin （青龙面板 Python 版）
 *
 * 配置（任选其一，按下列顺序生效）：
 *   - 脚本行 argument：一个 `邮箱#密码`，或账号 JSON 数组
 *   - 插件输入「多账号[JSON数组]」：JSON 数组
 *       [{"name":"甲","account":"a@x.com#pwdA"},{"name":"乙","account":"b@x.com#pwdB"}]
 *       （兼容旧格式每项写 {"name":"...","email":"...","password":"..."}）
 *   - 插件输入「单账号[邮箱]」和「单账号[密码]」：分开填写
 *   - 兼容插件旧输入「单账号[邮箱和密码]」：`邮箱#密码`
 *   - 旧 argument="manual" / "scheduled" 忽略，不作为账号解析
 *   - 插件输入「站点域名[可留空]」（可选）：覆盖站点域名，默认 https://agentrouter.org
 *   - 调度只由插件 cron 控制；手动运行直接执行，不读取旧小时配置
 *   旧版英文键（AGENTROUTER_ACCOUNT 等）仍能读，并会自动迁移到中文键。
 *
 * 说明：
 *   - cookie 由脚本自己管理（先 GET /login 拿 WAF 下发的 cookie，再显式回传），
 *     不依赖 Loon 的 auto-cookie，因此旧版 Loon 也能正常工作。
 *   - 重复运行不会重复发额度，服务端按天去重。
 *   - 为安全起见，BASE_URL 只允许 http/https 且拒绝本机/内网/保留地址。
 */

const LOGIN_PATH = "/api/user/login";
const SELF_LOG_PATH = "/api/log/self";
const SELF_LOG_HEADER = "New-API-User";
const CHECKIN_LOG_TYPE = 4;
const TIMEOUT = 20000; // $httpClient timeout 单位为毫秒
const MAX_ATTEMPTS = 10;
const ATTEMPT_GAP = 8000; // 每次失败后的间隔：拉开时间等风控放松，避免高频连打加重风控
const ACCOUNT_BUDGET = 250000; // 单账号最坏 10×20s 请求 + 9×8s 间隔 ≈ 227s
const RUN_BUDGET = 290000; // 留出通知与 $done 的余量（插件 timeout=300 秒）

// 版本号：手动触发一次后，在 Loon 日志里看这行就能确认当前跑的是哪一版。
// 更新脚本时同步递增，并同步更新 AgentRouter.checkin.plugin 的 #!desc。
const SCRIPT_VERSION = "1.5.2";

const DEFAULT_BASE_URL = "https://agentrouter.org";

// 插件输入项名称。Loon 旧式 `#!input` 没有单独的"说明"字段——方括号里的名字
// 就是用户在插件页面看到的标签，也是本地存储的键，所以这里直接用中文，用户才看得懂。
// 注意：插件头 `#!` 行里不能出现行内 `#`（会被当成注释），所以标签里避免用 `#`。
const FIELD_ACCOUNT = "单账号[邮箱和密码]";
const FIELD_ACCOUNTS = "多账号[JSON数组]";
const FIELD_BASE_URL = "站点域名[可留空]";
const FIELD_EMAIL = "单账号[邮箱]";
const FIELD_PASSWORD = "单账号[密码]";
// 可选：指定这些请求走哪个节点/策略组（Loon $httpClient 的 node 参数）。
// 填 DIRECT 表示直连，也可填已有策略组名；不能保证解决人机验证。
const FIELD_NODE = "指定节点或策略组[可留空]";

// 旧版（v1.1.0 及更早）的英文键名，继续兼容读取，并自动把值迁移到新键，
// 这样老用户升级插件后不用重新填账号。
const LEGACY_ACCOUNT = "AGENTROUTER_ACCOUNT";
const LEGACY_ACCOUNTS = "AGENTROUTER_ACCOUNTS";
const LEGACY_BASE_URL = "AGENTROUTER_BASE_URL";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// 站点在阿里云 WAF 后面（首个响应会下发 acw_tc cookie）。补齐浏览器常见请求头
// 可以让请求"更像正常浏览器"，降低被 WAF 判定为机器人而返回拦截页的概率。
const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Chromium";v="138", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin"
};

// ---------------------------------------------------------------- 基础工具

function log(msg) {
  console.log("[AgentRouter] " + msg);
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function readStore(key) {
  try {
    return $persistentStore.read(key) || "";
  } catch (e) {
    return "";
  }
}

// 读取插件输入项：优先新中文键；没有则回退读旧英文键，并把值迁移到新键，
// 让用户在插件页面能看到、也能继续用旧配置。
function readField(primary, legacy) {
  var v = readStore(primary);
  if (v) return v;
  var old = readStore(legacy);
  if (old) {
    try {
      $persistentStore.write(String(old), primary);
    } catch (e) {
      /* 迁移失败不影响本次使用 */
    }
    log("已将旧配置 " + legacy + " 迁移到「" + primary + "」");
    return old;
  }
  return "";
}

function getArgument() {
  try {
    return typeof $argument !== "undefined" && $argument ? String($argument) : "";
  } catch (e) {
    return "";
  }
}

function notify(title, content) {
  try {
    $notification.post(title, "", String(content));
  } catch (e) {
    log("通知发送失败(不影响签到): " + e);
  }
}

function headerGet(headers, name) {
  if (!headers) return "";
  var target = name.toLowerCase();
  for (var k in headers) {
    if (k.toLowerCase() === target) {
      var v = headers[k];
      return Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  return "";
}

function humanAgo(sec) {
  if (sec < 60) return sec + " 秒前";
  if (sec < 3600) return Math.floor(sec / 60) + " 分钟前";
  if (sec < 86400) return Math.floor(sec / 3600) + " 小时前";
  return Math.floor(sec / 86400) + " 天前";
}

function parseAccount(raw) {
  raw = (raw || "").trim();
  var i = raw.indexOf("#");
  if (i >= 0) return [raw.slice(0, i).trim(), raw.slice(i + 1).trim()];
  return [raw, ""];
}

function extractQuota(payload) {
  if (payload && typeof payload === "object") {
    var keys = ["quota", "remainder_quota", "balance"];
    for (var i = 0; i < keys.length; i++) {
      if (payload[keys[i]] !== undefined) return payload[keys[i]];
    }
  }
  return null;
}

// ------------------------------------------------- BASE_URL 安全校验
// 仅允许 http/https，拒绝 localhost、环回、私网与保留地址。
function isBlockedHost(host) {
  var h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || /\.localhost$/.test(h) || /\.local$/.test(h)) return true;
  if (h === "::1" || h === "::") return true;
  if (/^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true; // 链路本地 / ULA
  var m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    var a = +m[1],
      b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播 / 保留
  }
  return false;
}

function parseUrl(u) {
  try {
    if (typeof URL !== "undefined") {
      var p = new URL(u);
      return { protocol: p.protocol, hostname: p.hostname };
    }
  } catch (e) {
    /* 落到正则兜底 */
  }
  var m = String(u).match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^/?#]+)/);
  if (!m) return null;
  var host = m[2].replace(/^.*@/, "").replace(/:\d+$/, "");
  return { protocol: m[1].toLowerCase() + ":", hostname: host };
}

function validateBaseUrl(u) {
  var p = parseUrl(u);
  if (!p) return { ok: false, reason: "无法解析的 URL: " + u };
  if (p.protocol !== "http:" && p.protocol !== "https:")
    return { ok: false, reason: "仅允许 http/https，收到: " + p.protocol };
  if (isBlockedHost(p.hostname))
    return { ok: false, reason: "拒绝本机/内网/保留地址: " + p.hostname };
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP

function request(method, params, deadline) {
  return new Promise(function (resolve, reject) {
    var remaining = deadline ? deadline - Date.now() : TIMEOUT;
    if (remaining <= 0) return reject(new Error("时间预算已耗尽"));
    params.timeout = Math.min(params.timeout, remaining);
    var settled = false;
    var timer = setTimeout(function requestWatchdog() {
      settled = true;
      // 无取消 API，不能确认底层请求已结束；停止本账号，避免重叠登录。
      var err = new Error("请求回调超时，停止本账号");
      err.stopRetry = true;
      reject(err);
    }, params.timeout);
    var cb = function (err, resp, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(new Error(String(err)));
      else resolve({ resp: resp || {}, data: data });
    };
    var fn = ($httpClient && $httpClient[method]) || null;
    if (!fn) {
      cb("当前环境不支持 $httpClient." + method);
      return;
    }
    try { fn.call($httpClient, params, cb); } catch (e) { cb(e); }
  });
}

// 显式管理 Cookie，避免与 auto-cookie 同时写入；不据跨平台 build 号推断能力。
function httpGet(url, headers, node, deadline) {
  var p = {
    url: url,
    headers: headers || {},
    timeout: TIMEOUT,
    "auto-cookie": false
  };
  if (node) p.node = node;
  return request("get", p, deadline);
}

function httpPostJson(url, headers, obj, node, deadline) {
  var p = {
    url: url,
    headers: headers || {},
    body: JSON.stringify(obj),
    timeout: TIMEOUT,
    "auto-cookie": false
  };
  if (node) p.node = node;
  return request("post", p, deadline);
}

function clip(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// 从 HTML 里抽个 <title> 便于定位拦截页类型（阿里云 WAF 拦截页通常带特征标题）。
function htmlTitle(body) {
  var m = String(body || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clip(m[1], 80) : "";
}

// 识别阿里云 WAF 的"人机验证"页（滑块/JS 挑战）。
// 这种页面必须由浏览器执行脚本、人工拖动滑块才能通过，脚本无法自行解决，
// 因此要单独识别出来并给出明确提示，而不是笼统报"返回 HTML"。
function isCaptchaPage(body) {
  var s = String(body || "");
  return (
    s.indexOf("aliyun_waf_aa") >= 0 ||
    s.indexOf("aliyun_waf_bb") >= 0 ||
    /aliyunCaptcha/i.test(s) ||
    s.indexOf("nc-container") >= 0
  );
}

function loginHeaders(base, cookie) {
  var h = {};
  for (var k in BROWSER_HEADERS) h[k] = BROWSER_HEADERS[k];
  h["Content-Type"] = "application/json";
  h.Referer = base + "/login";
  h.Origin = base;
  if (cookie) h.Cookie = cookie;
  return h;
}

// 从响应头的 set-cookie 里提取 "k=v; k2=v2" 形式的 Cookie 串。
// 不依赖 Loon 的 auto-cookie（那个需要较新 build），显式回传更稳。
function extractCookies(respHeaders) {
  if (!respHeaders) return "";
  var raw = respHeaders["set-cookie"] || respHeaders["Set-Cookie"];
  if (!raw) {
    for (var k in respHeaders) {
      if (k.toLowerCase() === "set-cookie") {
        raw = respHeaders[k];
        break;
      }
    }
  }
  if (!raw) return "";
  var list = Array.isArray(raw) ? raw : String(raw).split(/,(?=[^;=]+=)/);
  var pairs = [];
  for (var i = 0; i < list.length; i++) {
    var first = String(list[i]).split(";")[0].trim();
    if (first && first.indexOf("=") > 0) pairs.push(first);
  }
  return pairs.join("; ");
}

// 按名称合并本轮 Cookie，避免新 Set-Cookie 覆盖未更新的 session。
function mergeCookies(current, incoming) {
  var pairs = (current + "; " + incoming).split(/;\s*/);
  var jar = Object.create(null);
  for (var i = 0; i < pairs.length; i++) {
    var pos = pairs[i].indexOf("=");
    if (pos > 0) jar[pairs[i].slice(0, pos).trim()] = pairs[i].slice(pos + 1);
  }
  return Object.keys(jar).map(function (key) { return key + "=" + jar[key]; }).join("; ");
}

async function warmUp(base, node, deadline) {
  var h = {};
  for (var k in BROWSER_HEADERS) h[k] = BROWSER_HEADERS[k];
  h.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  h["Sec-Fetch-Dest"] = "document";
  h["Sec-Fetch-Mode"] = "navigate";
  h["Sec-Fetch-Site"] = "none";
  try {
    var r = await httpGet(base + "/login", h, node, deadline);
    var cookie = extractCookies(r.resp.headers);
    log("会话预热: GET /login -> HTTP " + r.resp.status + (cookie ? "，已取得 cookie" : ""));
    return cookie;
  } catch (e) {
    log("会话预热失败(不影响后续): " + (e && e.message ? e.message : e));
    return "";
  }
}

// ---------------------------------------------------------------- 账号收集

function normalizeAccountsArray(arr) {
  var out = [];
  if (!arr || !arr.length) return out;
  for (var i = 0; i < arr.length; i++) {
    var a = arr[i] || {};
    var email = "",
      password = "";
    var parsed = parseAccount(a.account || "");
    email = parsed[0];
    password = parsed[1];
    if ((!email || !password) && a.email && a.password) {
      email = String(a.email).trim();
      password = String(a.password).trim();
    }
    if (email && password) {
      out.push({ name: a.name || "账号" + (i + 1), email: email, password: password });
    }
  }
  return out;
}

function tryParseAccountsJson(raw) {
  raw = (raw || "").trim();
  if (raw.charAt(0) !== "[") return null;
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? normalizeAccountsArray(arr) : null;
  } catch (e) {
    return null;
  }
}

function collectAccounts() {
  // 1) 脚本行 argument
  var arg = getArgument().trim();
  if (arg && arg !== "manual" && arg !== "scheduled") {
    var fromArg = tryParseAccountsJson(arg);
    if (fromArg && fromArg.length) {
      log("已读取脚本 argument 中的多账号配置, 共 " + fromArg.length + " 个");
      return fromArg;
    }
    var single = parseAccount(arg);
    if (single[0] && single[1]) {
      log("已读取脚本 argument 中的单账号配置");
      return [{ name: "默认账号", email: single[0], password: single[1] }];
    }
  }

  // 2) 多账号 JSON 数组
  var multiRaw = readField(FIELD_ACCOUNTS, LEGACY_ACCOUNTS).trim();
  if (multiRaw) {
    var list = tryParseAccountsJson(multiRaw);
    if (list && list.length) {
      log("已读取「" + FIELD_ACCOUNTS + "」, 共 " + list.length + " 个");
      return list;
    }
    if (list) log("「" + FIELD_ACCOUNTS + "」未解析出有效账号, 回退到单账号");
  }

  // 3) 分开输入；任一项已填则不静默回退到旧账号，密码原样保留。
  var email = readStore(FIELD_EMAIL).trim();
  var password = readStore(FIELD_PASSWORD);
  if (email || password) {
    if (email && password) return [{ name: "默认账号", email: email, password: password }];
    log("分开输入的账号和密码必须同时填写");
    return [];
  }

  // 4) 兼容旧单账号（邮箱#密码）
  var singleRaw = readField(FIELD_ACCOUNT, LEGACY_ACCOUNT).trim();
  if (singleRaw) {
    var one = parseAccount(singleRaw);
    if (one[0] && one[1]) {
      log("已读取「" + FIELD_ACCOUNT + "」(邮箱#密码)");
      return [{ name: "默认账号", email: one[0], password: one[1] }];
    }
  }

  log("未检测到任何配置: 请在插件里填写「" + FIELD_EMAIL + "」和「" + FIELD_PASSWORD + "」");
  return [];
}

// ---------------------------------------------------------------- 业务逻辑

function makeResult(name, status, message, username, quota) {
  var tag = { success: "✅ 成功", already: "🟡 已签到", fail: "❌ 失败" }[status] || status;
  var quotaStr = quota === null || quota === undefined ? "未知" : String(quota);
  log("[" + name + "] " + tag + " | " + message + " | 额度: " + quotaStr);
  return {
    name: name,
    status: status,
    message: message,
    username: username || "",
    quota: quota === undefined ? null : quota
  };
}

async function verifyCheckin(base, uid, cookie, node, deadline, slackNew, windowDays) {
  slackNew = slackNew || 300;
  windowDays = windowDays || 1;
  if (!uid) return { level: "error", detail: "缺少 uid, 跳过日志核验" };

  var url = base + SELF_LOG_PATH + "?p=1&page_size=20";
  var headers = {};
  for (var hk in BROWSER_HEADERS) headers[hk] = BROWSER_HEADERS[hk];
  headers.Accept = "application/json, text/plain, */*";
  headers[SELF_LOG_HEADER] = String(uid);
  headers.Referer = base + "/console/log";
  // 不依赖 auto-cookie（需较新 build），显式带上登录时拿到的 cookie。
  if (cookie) headers.Cookie = cookie;

  var r;
  try {
    r = await httpGet(url, headers, node, deadline);
  } catch (e) {
    return { level: "error", detail: "日志查询异常: " + e.message };
  }
  if (r.resp.status !== 200 || /text\/html/i.test(headerGet(r.resp.headers, "content-type"))) {
    return { level: "error", detail: "日志接口返回 HTTP " + r.resp.status };
  }
  var j;
  try {
    j = JSON.parse(r.data);
  } catch (e) {
    return { level: "error", detail: "日志响应非 JSON" };
  }

  var items = (j.data && j.data.items) || [];
  var now = Math.floor(Date.now() / 1000);
  var newestTs = null,
    newestContent = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var content = it.content || "";
    if (content.indexOf("签到成功") >= 0 || it.type === CHECKIN_LOG_TYPE) {
      var ts = it.created_at;
      if (typeof ts === "number" && (newestTs === null || ts > newestTs)) {
        newestTs = ts;
        newestContent = content;
      }
    }
  }
  if (newestTs === null) return { level: "none", detail: "日志中未找到任何签到记录" };

  var ago = now - newestTs;
  var agoStr = humanAgo(ago);
  if (newestTs >= now - slackNew)
    return { level: "new", detail: "本次运行已生成签到日志（" + agoStr + "）" };
  if (newestTs >= now - windowDays * 86400)
    return { level: "today", detail: "近 " + windowDays + " 天内有签到记录（" + agoStr + "），本次未新增" };
  return { level: "none", detail: "最近一条签到日志较旧（" + agoStr + "）" };
}

async function passwordLogin(base, acc, node, runDeadline) {
  var name = acc.name || "默认账号";
  var email = (acc.email || "").trim();
  var password = acc.password || "";
  if (!email || !password) return makeResult(name, "fail", "未配置 email/password, 跳过", null, null);

  log("====== 开始处理账号(账号密码登录): " + name + " ======");

  var deadline = Math.min(Date.now() + ACCOUNT_BUDGET, runDeadline);
  var cookie = "", j = null, lastError = "登录未完成", attemptsUsed = 0;
  try {
    for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (Date.now() >= deadline) { lastError = "时间预算已耗尽"; attemptsUsed = attempt - 1; break; }
      attemptsUsed = attempt;
      try {
        // 每次尝试前都刷新会话：上次失败可能烧掉了 cookie；GET 同时兼作连通性探测
        cookie = mergeCookies(cookie, await warmUp(base, node, deadline));
        var r = await httpPostJson(base + LOGIN_PATH, loginHeaders(base, cookie),
          { username: email, password: password }, node, deadline);
        cookie = mergeCookies(cookie, extractCookies(r.resp.headers));
        var status = Number(r.resp.status);
        var bodyText = typeof r.data === "string" ? r.data : "";
        var isHtml = /text\/html/i.test(headerGet(r.resp.headers, "content-type")) || /^\s*</.test(bodyText);
        var payload = null;
        try { payload = JSON.parse(bodyText); } catch (ignore) {}
        if (payload && payload.success === true && status >= 200 && status < 300) {
          j = payload;
          break; // 登录成功立即停止，日志失败也不重新登录
        }
        // 服务器明确说凭据错误：确定性失败，重试无意义且有锁号风险，首次即停
        if (payload && payload.success === false &&
            /密码|credential|password/i.test(String(payload.message || ""))) {
          return makeResult(name, "fail",
            "登录失败：" + (payload.message || "凭据错误") + "（确定性失败，未重试；请核对账号密码）",
            null, null);
        }
        // 其余失败（人机验证页/断连/5xx/限流/非 JSON）都算环境性失败：重试
        if (status >= 500) {
          lastError = "服务端暂时不可用(HTTP " + status + ")";
        } else if (isHtml) {
          lastError = "登录接口返回 HTML" + (isCaptchaPage(bodyText) ? "（人机验证页）" : "(疑似被 WAF 拦截)") +
            "，页面标题: " + (htmlTitle(bodyText) || "(无)");
        } else if (payload) {
          lastError = "登录失败：服务端未确认成功(HTTP " + status + ")";
        } else {
          lastError = "登录响应非 JSON(HTTP " + status + ")";
        }
        log("第 " + attempt + "/" + MAX_ATTEMPTS + " 次登录失败: " + lastError);
      } catch (e) {
        lastError = "登录请求异常: " + e.message;
        log("第 " + attempt + "/" + MAX_ATTEMPTS + " 次登录失败: " + lastError);
        // watchdog 触发 = Loon 回调挂起，底层请求可能仍在飞行；继续重试会堆叠登录，停止本账号。
        if (e.stopRetry) throw e;
      }
      if (attempt === MAX_ATTEMPTS) break;
      if (Date.now() + ATTEMPT_GAP >= deadline) { lastError = "时间预算已耗尽"; break; }
      log("等待 8 秒后刷新会话重试…");
      await sleep(ATTEMPT_GAP);
    }
  } catch (e) {
    lastError = e.message;
  }
  if (!j) {
    var prefix = attemptsUsed >= MAX_ATTEMPTS
      ? "连续 " + MAX_ATTEMPTS + " 次登录未成功："
      : "第 " + attemptsUsed + " 次后中止：";
    return makeResult(name, "fail", prefix + lastError, null, null);
  }

  var data = j.data || {};
  var checkedIn = !!data.checked_in;
  var username = data.username || data.display_name || email;
  var quota = extractQuota(data);
  var uid = data.id;
  var msg;

  if (checkedIn) {
    var v = await verifyCheckin(base, uid, cookie, node, deadline);
    if (v.level === "new" || v.level === "today") {
      msg = "签到成功，日志已确认（" + v.detail + "）";
    } else {
      msg = "登录成功且服务端返回已签到，但日志未确认: " + v.detail;
    }
  } else {
    msg = "登录成功，但 checked_in=false(可能今日额度已发或接口变化)";
  }
  return makeResult(name, "success", msg, username, quota);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  log("AgentRouter 自动签到启动 (Loon) v" + SCRIPT_VERSION);

  log("单一入口：按插件 cron 调度；手动运行直接执行（忽略旧小时配置）");

  var base = (readField(FIELD_BASE_URL, LEGACY_BASE_URL) || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  var guard = validateBaseUrl(base);
  if (!guard.ok) {
    log("BASE_URL 校验失败: " + guard.reason);
    notify("[AgentRouter] 签到失败", "BASE_URL 不合法：" + guard.reason);
    return;
  }

  var accounts = collectAccounts();
  if (!accounts.length) {
    notify("[AgentRouter] 签到失败", "未检测到账号配置，请同时填写「" + FIELD_EMAIL + "」和「" + FIELD_PASSWORD + "」，或检查多账号/旧配置");
    return;
  }

  // 可选：把请求固定到某个节点/策略组，用于避开触发 WAF 人机验证的出口。
  var node = readStore(FIELD_NODE).trim();
  if (node) log("本次请求将走节点/策略组: " + node);

  var results = [];
  var runDeadline = Date.now() + RUN_BUDGET;
  for (var i = 0; i < accounts.length; i++) {
    if (Date.now() >= runDeadline) {
      results.push(makeResult("剩余 " + (accounts.length - i) + " 个账号", "fail", "整轮时间预算已耗尽，未执行", null, null));
      break;
    }
    try {
      var res = await passwordLogin(base, accounts[i], node, runDeadline);
      if (res) results.push(res);
    } catch (e) {
      log("[" + (accounts[i].name || "?") + "] 处理异常: " + (e && e.message ? e.message : e));
    }
    if (accounts.length > 1 && i < accounts.length - 1) {
      await sleep(Math.min(3000, Math.max(0, runDeadline - Date.now())));
    }
  }

  if (!results.length) {
    notify("[AgentRouter] 签到失败", "所有账号均未成功执行");
    return;
  }

  var lines = [];
  for (var k = 0; k < results.length; k++) {
    var x = results[k];
    var tag = { success: "✅", already: "🟡", fail: "❌" }[x.status] || "";
    var quotaStr = x.quota === null || x.quota === undefined ? "未知" : String(x.quota);
    var who = x.username || x.name;
    lines.push(tag + " " + x.name + "(" + who + ")：" + x.message + " | 额度 " + quotaStr);
  }
  notify("[AgentRouter] 签到汇总", lines.join("\n"));
  log("全部账号处理完毕");
}

function runOnce() {
  return main()
    .catch(function (e) {
      var m = e && e.message ? e.message : String(e);
      log("脚本异常: " + m);
      notify("[AgentRouter] 签到失败", "脚本异常: " + m);
    })
    .then(function () {
      try {
        $done();
      } catch (e) {
        /* ignore */
      }
    });
}

// Loon 运行时下自动执行；被 Node require 时不自动运行，便于本地测试。
if (typeof module === "undefined" && typeof $done === "function" && typeof $httpClient === "object") {
  runOnce();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCRIPT_VERSION: SCRIPT_VERSION,
    main: main,
    runOnce: runOnce,
    validateBaseUrl: validateBaseUrl,
    isBlockedHost: isBlockedHost,
    parseAccount: parseAccount,
    extractQuota: extractQuota,
    humanAgo: humanAgo,
    readField: readField,
    clip: clip,
    htmlTitle: htmlTitle,
    isCaptchaPage: isCaptchaPage,
    loginHeaders: loginHeaders,
    extractCookies: extractCookies,
    mergeCookies: mergeCookies,
    FIELD_EMAIL: FIELD_EMAIL,
    FIELD_PASSWORD: FIELD_PASSWORD,
    FIELD_ACCOUNT: FIELD_ACCOUNT,
    FIELD_ACCOUNTS: FIELD_ACCOUNTS,
    FIELD_BASE_URL: FIELD_BASE_URL,
    FIELD_NODE: FIELD_NODE,
    normalizeAccountsArray: normalizeAccountsArray,
    collectAccounts: collectAccounts
  };
}
