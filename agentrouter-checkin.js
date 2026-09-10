/* eslint-disable */
/**
 * AgentRouter 自动签到 —— Loon 版（cron 定时脚本）
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
 *   - 插件输入「单账号[邮箱和密码]」：`邮箱#密码`
 *   - 插件输入「站点域名[可留空]」（可选）：覆盖站点域名，默认 https://agentrouter.org
 *   - 插件输入「签到时间点[可留空]」（可选）：如 "9,15,21"，只在匹配的小时签到
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
const TIMEOUT = 20000;

// 版本号：手动触发一次后，在 Loon 日志里看这行就能确认当前跑的是哪一版。
// 更新脚本时同步递增，并同步更新 AgentRouter.checkin.plugin 的 #!desc。
const SCRIPT_VERSION = "1.4.0";

const DEFAULT_BASE_URL = "https://agentrouter.org";

// 插件输入项名称。Loon 旧式 `#!input` 没有单独的"说明"字段——方括号里的名字
// 就是用户在插件页面看到的标签，也是本地存储的键，所以这里直接用中文，用户才看得懂。
// 注意：插件头 `#!` 行里不能出现行内 `#`（会被当成注释），所以标签里避免用 `#`。
const FIELD_ACCOUNT = "单账号[邮箱和密码]";
const FIELD_ACCOUNTS = "多账号[JSON数组]";
const FIELD_BASE_URL = "站点域名[可留空]";
// 可选：限定只在一天中的哪些小时真正执行（配合 `0 * * * *` 的每小时 cron 用）。
// 例如 "9,15,21" 表示每天 9/15/21 点各签到一次；留空则每次触发都执行。
const FIELD_RUN_HOURS = "签到时间点[可留空]";
// 可选：指定这些请求走哪个节点/策略组（Loon $httpClient 的 node 参数）。
// 站点挂在阿里云 WAF 后，若经由机房出口的代理节点访问，容易被判为机器人并弹人机验证；
// 填 DIRECT 表示直连（不经代理），通常能避开；也可填你配置里的某个策略组名。
const FIELD_NODE = "指定节点或策略组[可留空]";

// 旧版（v1.1.0 及更早）的英文键名，继续兼容读取，并自动把值迁移到新键，
// 这样老用户升级插件后不用重新填账号。
const LEGACY_ACCOUNT = "AGENTROUTER_ACCOUNT";
const LEGACY_ACCOUNTS = "AGENTROUTER_ACCOUNTS";
const LEGACY_BASE_URL = "AGENTROUTER_BASE_URL";
const LEGACY_RUN_HOURS = "AGENTROUTER_RUN_HOURS";

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

// 解析「签到时间点」："9,15,21" 或 "9-11"（也支持跨午夜 "22-2"）。
// 返回 0-23 的整数数组；无法解析的片段忽略。返回空数组表示"不做小时限制"。
function parseRunHours(raw) {
  var found = [];
  var parts = String(raw == null ? "" : raw).split(",");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var m = p.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (m) {
      var a = parseInt(m[1], 10);
      var b = parseInt(m[2], 10);
      if (a > 23 || b > 23) continue;
      if (a <= b) {
        for (var h = a; h <= b; h++) found.push(h);
      } else {
        for (var h2 = a; h2 <= 23; h2++) found.push(h2);
        for (var h3 = 0; h3 <= b; h3++) found.push(h3);
      }
      continue;
    }
    if (/^\d{1,2}$/.test(p)) {
      var v = parseInt(p, 10);
      if (v >= 0 && v <= 23) found.push(v);
    }
  }
  var out = [];
  for (var j = 0; j < found.length; j++) {
    if (out.indexOf(found[j]) < 0) out.push(found[j]);
  }
  return out;
}

function shouldRunNow(hours, hour) {
  if (!hours || !hours.length) return true;
  return hours.indexOf(hour) >= 0;
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

function request(method, params) {
  return new Promise(function (resolve, reject) {
    var cb = function (err, resp, data) {
      if (err) reject(new Error(String(err)));
      else resolve({ resp: resp || {}, data: data });
    };
    var fn = ($httpClient && $httpClient[method]) || null;
    if (!fn) {
      reject(new Error("当前环境不支持 $httpClient." + method));
      return;
    }
    fn.call($httpClient, params, cb);
  });
}

// 注意：显式关掉 Loon 的 auto-cookie，改用我们自己从 set-cookie 提取并回传的
// Cookie（见 warmUp / extractCookies）。这样在旧版 Loon（auto-cookie 需 build
// 662+）上行为一致，也不会出现两套 cookie 机制同时写入造成重复头。
// node 为可选：填了就让这些请求走指定节点/策略组（DIRECT=直连），用于避开
// 机房出口 IP 触发的人机验证。
function httpGet(url, headers, node) {
  var p = {
    url: url,
    headers: headers || {},
    timeout: TIMEOUT,
    "auto-cookie": false
  };
  if (node) p.node = node;
  return request("get", p);
}

function httpPostJson(url, headers, obj, node) {
  var p = {
    url: url,
    headers: headers || {},
    body: JSON.stringify(obj),
    timeout: TIMEOUT,
    "auto-cookie": false
  };
  if (node) p.node = node;
  return request("post", p);
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

// 先访问一次登录页，拿到 WAF 下发的 acw_tc cookie，并把它显式带回后续请求。
// 目的是让 POST 看起来像同一次正常的浏览器会话（很多 WAF 要求先拿到 cookie）。
async function warmUp(base, node) {
  var h = {};
  for (var k in BROWSER_HEADERS) h[k] = BROWSER_HEADERS[k];
  h.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  h["Sec-Fetch-Dest"] = "document";
  h["Sec-Fetch-Mode"] = "navigate";
  h["Sec-Fetch-Site"] = "none";
  try {
    var r = await httpGet(base + "/login", h, node);
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
  if (arg) {
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

  // 3) 单账号（邮箱#密码）
  var singleRaw = readField(FIELD_ACCOUNT, LEGACY_ACCOUNT).trim();
  if (singleRaw) {
    var one = parseAccount(singleRaw);
    if (one[0] && one[1]) {
      log("已读取「" + FIELD_ACCOUNT + "」(邮箱#密码)");
      return [{ name: "默认账号", email: one[0], password: one[1] }];
    }
  }

  log("未检测到任何配置: 请在插件里填写「" + FIELD_ACCOUNT + "」(格式 邮箱#密码)");
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

async function verifyCheckin(base, uid, cookie, node, slackNew, windowDays) {
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
    r = await httpGet(url, headers, node);
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

async function passwordLogin(base, acc, node) {
  var name = acc.name || "默认账号";
  var email = (acc.email || "").trim();
  var password = (acc.password || "").trim();
  if (!email || !password) return makeResult(name, "fail", "未配置 email/password, 跳过", null, null);

  log("====== 开始处理账号(账号密码登录): " + name + " ======");

  // 先预热会话拿 WAF cookie，再登录。失败分三类处理：
  //   - 5xx（负载均衡/后端临时不可用）：退避后重试；
  //   - 人机验证页：脚本无法解决，立即失败（重试只会加重风控）；
  //   - 其它 HTML（普通拦截页）：重新预热会话后重试。
  var cookie = await warmUp(base, node);

  var MAX_ATTEMPTS = 3;
  var r, bodyText, isHtml;
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      r = await httpPostJson(base + LOGIN_PATH, loginHeaders(base, cookie), { username: email, password: password }, node);
    } catch (e) {
      return makeResult(name, "fail", "登录请求异常: " + e.message, null, null);
    }
    var setCookie = extractCookies(r.resp.headers);
    if (setCookie) cookie = setCookie; // 续上服务端新下发的 cookie

    var status = r.resp.status;
    bodyText = typeof r.data === "string" ? r.data : "";
    isHtml = /text\/html/i.test(headerGet(r.resp.headers, "content-type")) || /^\s*</.test(bodyText.slice(0, 1));

    // 人机验证页：脚本无法执行 JS / 拖滑块，直接明确失败并给出解法，不要浪费重试
    if (isHtml && isCaptchaPage(bodyText)) {
      log("检测到阿里云 WAF 人机验证页（HTTP " + status + "），脚本无法自行通过，停止重试");
      return makeResult(
        name,
        "fail",
        "站点要求人机验证(阿里云 WAF)。脚本无法自动通过；通常是当前出口 IP(代理/机房) 被风控，" +
          "请在插件里把「" + FIELD_NODE + "」填成 DIRECT 直连，或换一个干净节点后重试",
        null,
        null
      );
    }

    // 5xx：服务端/负载均衡临时故障，与我们的请求无关，退避重试即可
    if (status >= 500) {
      log("第 " + attempt + " 次登录: HTTP " + status + "（服务端暂时不可用）" + (isHtml ? " 标题: " + (htmlTitle(bodyText) || "(无)") : ""));
      if (attempt < MAX_ATTEMPTS) {
        var wait = attempt * 3000;
        log("等待 " + wait / 1000 + " 秒后重试…");
        await sleep(wait);
        continue;
      }
      return makeResult(name, "fail", "服务端暂时不可用(HTTP " + status + ")，请稍后重试", null, null);
    }

    if (!isHtml) break; // 正常 JSON

    log(
      "第 " + attempt + " 次登录返回 HTML: HTTP " + status +
        " | Content-Type: " + (headerGet(r.resp.headers, "content-type") || "(空)") +
        " | 标题: " + (htmlTitle(bodyText) || "(无)") +
        " | 正文: " + clip(bodyText, 200)
    );
    if (attempt < MAX_ATTEMPTS) {
      log("疑似被 WAF 拦截（非人机验证），重新预热会话后重试…");
      cookie = await warmUp(base, node);
    }
  }

  if (isHtml) {
    var hint = htmlTitle(bodyText);
    return makeResult(
      name,
      "fail",
      "登录接口返回 HTML(HTTP " + r.resp.status + "，疑似被 WAF 拦截)" +
        (hint ? " 页面标题: " + hint : "") +
        " | 正文片段: " + clip(bodyText, 160),
      null,
      null
    );
  }

  var j;
  try {
    j = JSON.parse(r.data);
  } catch (e) {
    return makeResult(name, "fail", "登录响应非 JSON: " + bodyText.slice(0, 120), null, null);
  }
  if (!j.success) {
    return makeResult(name, "fail", "登录失败: " + (j.message || bodyText.slice(0, 120)), null, null);
  }

  var data = j.data || {};
  var checkedIn = !!data.checked_in;
  var username = data.username || data.display_name || email;
  var quota = extractQuota(data);
  var uid = data.id;
  var msg;

  if (checkedIn) {
    var v = await verifyCheckin(base, uid, cookie, node);
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

  var runHours = parseRunHours(readField(FIELD_RUN_HOURS, LEGACY_RUN_HOURS));
  if (runHours.length) {
    var hour = new Date().getHours();
    if (!shouldRunNow(runHours, hour)) {
      log("当前 " + hour + " 点不在「" + FIELD_RUN_HOURS + "」(" + runHours.join(",") + ") 内，本次跳过");
      return;
    }
  }

  var base = (readField(FIELD_BASE_URL, LEGACY_BASE_URL) || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  var guard = validateBaseUrl(base);
  if (!guard.ok) {
    log("BASE_URL 校验失败: " + guard.reason);
    notify("[AgentRouter] 签到失败", "BASE_URL 不合法：" + guard.reason);
    return;
  }

  var accounts = collectAccounts();
  if (!accounts.length) {
    notify("[AgentRouter] 签到失败", "未检测到账号配置，请在插件里填写「" + FIELD_ACCOUNT + "」（格式 邮箱#密码）");
    return;
  }

  // 可选：把请求固定到某个节点/策略组，用于避开触发 WAF 人机验证的出口。
  var node = readStore(FIELD_NODE).trim();
  if (node) log("本次请求将走节点/策略组: " + node);

  var results = [];
  for (var i = 0; i < accounts.length; i++) {
    try {
      var res = await passwordLogin(base, accounts[i], node);
      if (res) results.push(res);
    } catch (e) {
      log("[" + (accounts[i].name || "?") + "] 处理异常: " + (e && e.message ? e.message : e));
    }
    if (accounts.length > 1 && i < accounts.length - 1) {
      await sleep(3000);
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
    parseRunHours: parseRunHours,
    shouldRunNow: shouldRunNow,
    readField: readField,
    clip: clip,
    htmlTitle: htmlTitle,
    isCaptchaPage: isCaptchaPage,
    loginHeaders: loginHeaders,
    extractCookies: extractCookies,
    FIELD_ACCOUNT: FIELD_ACCOUNT,
    FIELD_ACCOUNTS: FIELD_ACCOUNTS,
    FIELD_BASE_URL: FIELD_BASE_URL,
    FIELD_RUN_HOURS: FIELD_RUN_HOURS,
    FIELD_NODE: FIELD_NODE,
    normalizeAccountsArray: normalizeAccountsArray,
    collectAccounts: collectAccounts
  };
}
