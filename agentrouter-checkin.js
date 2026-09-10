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
 *   - 插件输入 AGENTROUTER_ACCOUNTS：JSON 数组
 *       [{"name":"甲","account":"a@x.com#pwdA"},{"name":"乙","account":"b@x.com#pwdB"}]
 *       （兼容旧格式每项写 {"name":"...","email":"...","password":"..."}）
 *   - 插件输入 AGENTROUTER_ACCOUNT：`邮箱#密码`
 *   - 插件输入 AGENTROUTER_BASE_URL（可选）：覆盖站点域名，默认 https://agentrouter.org
 *
 * 说明：
 *   - session cookie 由 Loon 的 auto-cookie 在同一 host 内自动沿用，无需手动处理。
 *   - 重复运行不会重复发额度，服务端按天去重。
 *   - 为安全起见，BASE_URL 只允许 http/https 且拒绝本机/内网/保留地址。
 */

const LOGIN_PATH = "/api/user/login";
const SELF_LOG_PATH = "/api/log/self";
const SELF_LOG_HEADER = "New-API-User";
const CHECKIN_LOG_TYPE = 4;
const TIMEOUT = 20000;

const DEFAULT_BASE_URL = "https://agentrouter.org";

const STORE_ACCOUNT = "AGENTROUTER_ACCOUNT";
const STORE_ACCOUNTS = "AGENTROUTER_ACCOUNTS";
const STORE_BASE_URL = "AGENTROUTER_BASE_URL";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

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

function httpGet(url, headers) {
  return request("get", {
    url: url,
    headers: headers || {},
    timeout: TIMEOUT,
    "auto-cookie": true
  });
}

function httpPostJson(url, headers, obj) {
  return request("post", {
    url: url,
    headers: headers || {},
    body: JSON.stringify(obj),
    timeout: TIMEOUT,
    "auto-cookie": true
  });
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

  // 2) AGENTROUTER_ACCOUNTS（JSON 数组）
  var multiRaw = readStore(STORE_ACCOUNTS).trim();
  if (multiRaw) {
    var list = tryParseAccountsJson(multiRaw);
    if (list && list.length) {
      log("已读取 AGENTROUTER_ACCOUNTS, 共 " + list.length + " 个");
      return list;
    }
    if (list) log("AGENTROUTER_ACCOUNTS 未解析出有效账号, 回退到单账号");
  }

  // 3) AGENTROUTER_ACCOUNT（邮箱#密码）
  var singleRaw = readStore(STORE_ACCOUNT).trim();
  if (singleRaw) {
    var one = parseAccount(singleRaw);
    if (one[0] && one[1]) {
      log("已读取 AGENTROUTER_ACCOUNT (邮箱#密码)");
      return [{ name: "默认账号", email: one[0], password: one[1] }];
    }
  }

  log("未检测到任何配置: 请设置 AGENTROUTER_ACCOUNT=邮箱#密码 或 AGENTROUTER_ACCOUNTS");
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

async function verifyCheckin(base, uid, slackNew, windowDays) {
  slackNew = slackNew || 300;
  windowDays = windowDays || 1;
  if (!uid) return { level: "error", detail: "缺少 uid, 跳过日志核验" };

  var url = base + SELF_LOG_PATH + "?p=1&page_size=20";
  var headers = { "User-Agent": UA };
  headers[SELF_LOG_HEADER] = String(uid);

  var r;
  try {
    r = await httpGet(url, headers);
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

async function passwordLogin(base, acc) {
  var name = acc.name || "默认账号";
  var email = (acc.email || "").trim();
  var password = (acc.password || "").trim();
  if (!email || !password) return makeResult(name, "fail", "未配置 email/password, 跳过", null, null);

  log("====== 开始处理账号(账号密码登录): " + name + " ======");
  var headers = {
    "User-Agent": UA,
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Referer: base + "/login",
    Origin: base
  };

  var r;
  try {
    r = await httpPostJson(base + LOGIN_PATH, headers, { username: email, password: password });
  } catch (e) {
    return makeResult(name, "fail", "登录请求异常: " + e.message, null, null);
  }

  var bodyText = typeof r.data === "string" ? r.data : "";
  if (/text\/html/i.test(headerGet(r.resp.headers, "content-type")) || /^\s*</.test(bodyText.slice(0, 1))) {
    return makeResult(name, "fail", "登录接口返回 HTML(可能被 WAF 拦截或路径变化)", null, null);
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
    var v = await verifyCheckin(base, uid);
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
  log("AgentRouter 自动签到启动 (Loon)");

  var base = (readStore(STORE_BASE_URL) || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  var guard = validateBaseUrl(base);
  if (!guard.ok) {
    log("BASE_URL 校验失败: " + guard.reason);
    notify("[AgentRouter] 签到失败", "BASE_URL 不合法：" + guard.reason);
    return;
  }

  var accounts = collectAccounts();
  if (!accounts.length) {
    notify("[AgentRouter] 签到失败", "未检测到账号配置，请填写 AGENTROUTER_ACCOUNT=邮箱#密码");
    return;
  }

  var results = [];
  for (var i = 0; i < accounts.length; i++) {
    try {
      var res = await passwordLogin(base, accounts[i]);
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
    main: main,
    runOnce: runOnce,
    validateBaseUrl: validateBaseUrl,
    isBlockedHost: isBlockedHost,
    parseAccount: parseAccount,
    extractQuota: extractQuota,
    humanAgo: humanAgo,
    normalizeAccountsArray: normalizeAccountsArray,
    collectAccounts: collectAccounts
  };
}
