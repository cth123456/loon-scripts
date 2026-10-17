/**
 * EOOS 每日签到 — Loon 脚本（公开版，不含任何凭证）
 *
 * 站点：https://eoos.top
 *
 * 接口流程（从站点前端 UserDashboard 模块还原）：
 *   1. POST /api/auth/login        用账号密码换 token（登录未开启人机验证）
 *   2. GET  /api/checkin/status    读取今天是否已签到
 *   3. POST /api/cap/challenge     获取签到人机验证挑战（Cap 工作量证明）
 *   4. POST /api/cap/redeem        提交解答，换取 verificationToken
 *   5. POST /api/checkin           正式签到
 *
 * 令牌：首次运行用账号密码登录，token 存入 Loon 本地键 eoos_token；
 *       之后优先复用缓存，接口返回 401 时自动重新登录，不需要手动抓 token。
 *
 * 定时：插件使用每小时唤起的 cron，按「签到时间点[可留空]」在设备本地小时过滤；
 *       留空则每小时执行。独立 generic 入口是手动运行，绕过小时过滤。
 *
 * 签到验证是 SHA-256 前缀工作量证明，不是图片验证码；timeout 建议 120 秒。
 */

var BASE = "https://eoos.top";
var SCRIPT_VERSION = "1.2.0";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

var FIELD_USER = "单账号[用户名或邮箱]";
var FIELD_PASS = "单账号[密码]";
var FIELD_HOURS = "签到时间点[可留空]";
var FIELD_NODE = "指定节点或策略组[可留空]";
var FIELD_TOKEN = "EOOS_TOKEN";
var TOKEN_KEY = "eoos_token";
var LEGACY_USER = "EOOS_USERNAME";
var LEGACY_PASS = "EOOS_PASSWORD";

// ---------------- SHA-256（单块，消息 < 56 字节） ----------------
var K256 = new Int32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

// ---------------- Cap 工作量证明 ----------------
// salt/target 由 token+序号经 FNV-1a + xorshift 生成；求 nonce 使
// SHA-256(salt + nonce) 的十六进制前缀等于 target 的前 d 位。
function capPrng(seed, length) {
  var hash = 2166136261;
  for (var i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  var state = hash >>> 0, out = "";
  function next() { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
  while (out.length < length) {
    var part = next().toString(16);
    while (part.length < 8) part = "0" + part;
    out += part;
  }
  return out.substring(0, length);
}

function solveOne(salt, targetHex) {
  var sl = salt.length, d = targetHex.length;
  var full = d >> 1;
  var nib = (d & 1) ? parseInt(targetHex.charAt(d - 1), 16) : -1;
  var want = full > 0 ? parseInt(targetHex.substr(0, full * 2), 16) : 0;
  var shift = 32 - 8 * full;

  // 把 salt 固化成 16 个 32 位字；每轮复制后只改 nonce、padding 和长度字。
  var base = new Int32Array(16);
  var block = new Int32Array(16);
  var w = new Int32Array(64);
  var i, pos, wi, sh;
  for (i = 0; i < sl; i++) {
    pos = i; wi = pos >> 2; sh = (3 - (pos & 3)) * 8;
    base[wi] = base[wi] | ((salt.charCodeAt(i) & 255) << sh);
  }

  var a, b, c, dd, e, f, g, h, nonce = 0, ns, nl, ml, bits, x, y, s0, s1, S0, S1, ch, maj, t1, t2, o0;
  for (;;) {
    ns = "" + nonce; nl = ns.length; ml = sl + nl;
    for (i = 0; i < 16; i++) block[i] = base[i];
    for (i = 0; i < nl; i++) {
      pos = sl + i; wi = pos >> 2; sh = (3 - (pos & 3)) * 8;
      block[wi] = (block[wi] & ~(255 << sh)) | ((ns.charCodeAt(i) & 255) << sh);
    }
    pos = ml; wi = pos >> 2; sh = (3 - (pos & 3)) * 8;
    block[wi] = block[wi] | (0x80 << sh);
    bits = ml * 8;
    block[14] = 0;
    block[15] = bits | 0;

    for (i = 0; i < 16; i++) w[i] = block[i];
    for (i = 16; i < 64; i++) {
      x = w[i - 15]; y = w[i - 2];
      s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    a = 0x6a09e667; b = 0xbb67ae85; c = 0x3c6ef372; dd = 0xa54ff53a;
    e = 0x510e527f; f = 0x9b05688c; g = 0x1f83d9ab; h = 0x5be0cd19;
    for (i = 0; i < 64; i++) {
      S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      ch = (e & f) ^ (~e & g);
      t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      maj = (a & b) ^ (a & c) ^ (b & c);
      t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    o0 = (a + 0x6a09e667) | 0;
    if (full === 0) {
      if (nib < 0 || ((o0 >>> 28) & 15) === nib) return nonce;
    } else if ((o0 >>> shift) === want) {
      if (nib < 0 || (((o0 >>> (shift - 4)) & 15) === nib)) return nonce;
    }
    nonce++;
  }
}

// ---------------- 配置与时间 ----------------
function readField(key, legacy) {
  try {
    if (typeof $persistentStore === "undefined") return "";
    var v = $persistentStore.read(key);
    if (v != null && String(v).trim() !== "") return String(v).trim();
    if (legacy) {
      var old = $persistentStore.read(legacy);
      if (old != null && String(old).trim() !== "") return String(old).trim();
    }
  } catch (e) {}
  return "";
}

function writeField(key, value) {
  try { if (typeof $persistentStore !== "undefined") $persistentStore.write(value, key); } catch (e) {}
}

function getArgument() {
  try { return (typeof $argument !== "undefined" && $argument) ? String($argument).trim() : ""; } catch (e) { return ""; }
}

// "9,15,21" / "9-11" / 跨午夜 "22-2"；非法片段忽略；空数组表示不限制小时。
function parseRunHours(raw) {
  var found = [], parts = String(raw == null ? "" : raw).split(",");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var m = p.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (m) {
      var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > 23 || b > 23) continue;
      if (a <= b) { for (var h = a; h <= b; h++) found.push(h); }
      else {
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
  for (var j = 0; j < found.length; j++) if (out.indexOf(found[j]) < 0) out.push(found[j]);
  return out;
}

// ---------------- HTTP ----------------
// 请求默认 DIRECT，避免代理节点或 MITM 造成的证书链问题；
// 需要走代理时在插件里填「指定节点或策略组」。
function http(method, path, body, token, node, cb) {
  var opt = {
    url: BASE + path,
    timeout: 20000,
    "auto-cookie": false,
    headers: {
      "Origin": BASE,
      "Referer": BASE + "/dashboard",
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*"
    }
  };
  if (node) opt.node = node;
  if (token) opt.headers["Authorization"] = "Bearer " + token;
  if (body != null) {
    opt.body = JSON.stringify(body);
    opt.headers["Content-Type"] = "application/json";
  }
  var fn = method === "GET" ? $httpClient.get : $httpClient.post;
  fn(opt, function (err, resp, data) {
    if (err) return cb(err);
    cb(null, { status: (resp && resp.status) || 0, body: data != null ? data : ((resp && resp.body) || "") });
  });
}

function isTlsError(err) {
  return /certificate verify failed|TLSError|SSL handshake|errSSL/i.test(String(err || ""));
}

var usedNode = "";
function httpSafe(method, path, body, token, cb) {
  var configured = readField(FIELD_NODE) || "DIRECT";
  usedNode = configured;
  http(method, path, body, token, configured, function (err, resp) {
    if (!err) return cb(null, resp);
    if (!isTlsError(err) || configured.toUpperCase() === "DIRECT") {
      return cb(err);
    }
    // 配置的节点证书校验失败：改用 DIRECT 重试（仍然校验证书）。
    log("节点 " + configured + " TLS 校验失败，改用 DIRECT 重试");
    usedNode = "DIRECT";
    http(method, path, body, token, "DIRECT", function (err2, resp2) {
      if (err2) return cb(err2);
      cb(null, resp2);
    });
  });
}

// TLS 失败后判断是「仅本站」还是「Loon 全局信任链」问题；只读公开地址，不发送凭据。
function diagnoseTls(err, cb) {
  http("GET", "https://api.github.com/zen", null, null, "DIRECT", function (e, r) {
    var globalBroken = !!e;
    cb({
      globalBroken: globalBroken,
      detail: globalBroken ? ("连 api.github.com 也失败：" + String(e).slice(0, 120)) : "其他 HTTPS 站点正常"
    });
  });
}

function tlsNote() {
  return usedNode === "DIRECT" && (readField(FIELD_NODE) || "DIRECT").toUpperCase() !== "DIRECT"
    ? "；已改用 DIRECT"
    : "";
}

function tlsHint(info) {
  if (!info) return "";
  if (info.globalBroken) {
    return "Loon 的 TLS 信任链异常（" + info.detail + "）。请更新 Loon，或在 Loon 中重新安装/信任证书。";
  }
  return "仅 eoos.top 校验失败（" + info.detail + "）。请检查 Loon 的 MITM 是否包含 eoos.top、Loon 根证书是否已信任，或把「指定节点或策略组」改为 DIRECT/其他可用节点。";
}

function parse(str) { try { return JSON.parse(str); } catch (e) { return null; } }

function log(msg) { console.log("[EOOS] " + msg); }

function finish(title, subtitle, body, silent) {
  log(title + (subtitle ? " | " + subtitle : "") + (body ? " | " + body : ""));
  if (!silent) {
    try { $notification.post("EOOS 签到 · " + title, subtitle || "", body || ""); } catch (e) {}
  }
  $done();
}

// ---------------- 登录 ----------------
function login(cb) {
  var user = readField(FIELD_USER, LEGACY_USER);
  var pass = readField(FIELD_PASS, LEGACY_PASS);
  if (!user || !pass) return cb("未配置账号：请在插件里填写「单账号[用户名或邮箱]」和「单账号[密码]」");
  httpSafe("POST", "/api/auth/login", { userName: user, password: pass }, null, function (err, resp) {
    if (err) {
      if (!isTlsError(err)) return cb("登录请求失败：" + err);
      return diagnoseTls(err, function (info) { cb("TLS 证书校验失败。" + tlsHint(info)); });
    }
    var out = parse(resp.body);
    if (out && out.token) {
      writeField(TOKEN_KEY, out.token);
      log("登录成功，已缓存令牌");
      return cb(null, out.token);
    }
    cb("登录失败：" + ((out && out.message) || ("HTTP " + resp.status)));
  });
}

// ---------------- 签到 ----------------
function solveCap(token, cb) {
  httpSafe("POST", "/api/cap/challenge", null, token, function (err, resp) {
    if (err) {
      if (!isTlsError(err)) return cb("请求挑战失败：" + err);
      return diagnoseTls(err, function (info) { cb("TLS 证书校验失败。" + tlsHint(info)); });
    }
    var data = parse(resp.body);
    if (!data || !data.token || !data.challenge) return cb("挑战返回异常：" + resp.body);
    var c = data.challenge.c, s = data.challenge.s, d = data.challenge.d;
    var solutions = [], i;
    try {
      for (i = 1; i <= c; i++) {
        solutions.push(solveOne(capPrng(data.token + i, s), capPrng(data.token + i + "d", d)));
      }
    } catch (e) {
      return cb("求解异常：" + e);
    }
    httpSafe("POST", "/api/cap/redeem", { token: data.token, solutions: solutions }, token, function (e2, r2) {
      if (e2) {
        if (!isTlsError(e2)) return cb("兑换请求失败：" + e2);
        return diagnoseTls(e2, function (info) { cb("TLS 证书校验失败。" + tlsHint(info)); });
      }
      var out = parse(r2.body);
      if (!out || !out.success || !out.token) return cb("兑换失败：" + ((out && out.message) || r2.body));
      cb(null, out.token);
    });
  });
}

function runCheckin(token, retried, cb) {
  httpSafe("GET", "/api/checkin/status", null, token, function (err, resp) {
    if (err) {
      if (!isTlsError(err)) return cb("查询失败：" + err);
      return diagnoseTls(err, function (info) { cb("TLS 证书校验失败。" + tlsHint(info)); });
    }

    if (resp.status === 401) {
      if (retried) return cb("登录已失效，且账号密码未配置或登录失败");
      log("缓存的令牌已失效，重新登录");
      return login(function (lerr, fresh) {
        if (lerr) return cb(lerr);
        runCheckin(fresh, true, cb);
      });
    }

    var st = parse(resp.body);
    if (!st || st.success !== true) return cb("状态异常：" + ((st && st.message) || resp.body));
    if (st.hasCheckedInToday) {
      return cb(null, "今日已签到", "本次获得 " + (st.amount || 0) + " " + (st.currencyUnit || "RCoin") + tlsNote());
    }

    solveCap(token, function (capErr, verificationToken) {
      if (capErr) return cb(capErr);
      httpSafe("POST", "/api/checkin", verificationToken ? { verificationToken: verificationToken } : {}, token, function (e3, r3) {
        if (e3) {
          if (!isTlsError(e3)) return cb("签到请求失败：" + e3);
          return diagnoseTls(e3, function (info) { cb("TLS 证书校验失败。" + tlsHint(info)); });
        }
        var out = parse(r3.body);
        if (out && out.success) {
          var line = "本次获得 " + (out.amount || 0) + " " + (out.currencyUnit || "RCoin");
          if (out.balance != null) line += "，余额 " + out.balance;
          return cb(null, "签到成功", line + tlsNote());
        }
        if (r3.status === 400 && out && out.hasCheckedIn) {
          return cb(null, "今日已签到", "本次获得 " + (out.amount || 0) + " " + (out.currencyUnit || "RCoin") + tlsNote());
        }
        cb("签到失败：HTTP " + r3.status + " " + ((out && out.message) || r3.body));
      });
    });
  });
}

// ---------------- 入口 ----------------
(function main() {
  log("启动 v" + SCRIPT_VERSION);

  var manual = getArgument() === "manual";
  var hours = parseRunHours(readField(FIELD_HOURS));
  if (!manual && hours.length) {
    var hour = new Date().getHours();
    if (hours.indexOf(hour) < 0) {
      return finish("跳过", "当前 " + hour + " 点不在签到时间点 " + hours.join(","), "", true);
    }
  }
  log(manual ? "手动入口：绕过小时过滤" : "定时入口：小时过滤 " + (hours.length ? hours.join(",") : "未设置（每小时）"));

  var cached = readField(TOKEN_KEY) || readField(FIELD_TOKEN);
  if (cached) {
    log("复用缓存令牌");
    return runCheckin(cached, false, function (err, title, detail) {
      if (err) return finish("执行失败", err, "");
      finish(title, detail, "");
    });
  }

  log("没有缓存令牌，使用账号密码登录");
  login(function (err, token) {
    if (err) return finish("未就绪", err, "");
    runCheckin(token, false, function (err2, title, detail) {
      if (err2) return finish("执行失败", err2, "");
      finish(title, detail, "");
    });
  });
})();
