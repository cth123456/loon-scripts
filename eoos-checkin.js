/**
 * EOOS 每日签到 — Loon 脚本（公开版，不含任何凭证）
 *
 * 站点：https://eoos.top
 *
 * 接口流程（从站点前端 UserDashboard 模块还原）：
 *   1. GET  /api/checkin/status   读取今天是否已签到
 *   2. POST /api/cap/challenge    获取签到人机验证挑战（Cap 工作量证明）
 *   3. POST /api/cap/redeem       提交解答，换取 verificationToken
 *   4. POST /api/checkin          正式签到
 *
 * 使用：通过同仓库的 EOOS.plugin 安装，在 Loon 插件配置里填写 EOOS_TOKEN。
 * EOOS_TOKEN 是网页登录后的 auth_token，只保存在 Loon 本地，不会上传到本仓库。
 *
 * 可选：脚本顶部 TOKEN / USERNAME / PASSWORD 也可直接填写（不建议提交修改后的版本）。
 * 签到验证是 SHA-256 前缀工作量证明，不是图片验证码；timeout 建议 120 秒。
 */

var BASE = "https://eoos.top";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ======== 可选：只在本机填写，推荐留空用抓取模式 ========
var TOKEN = "";      // 网页登录后的 auth_token
var USERNAME = "";   // 账号或邮箱（仅在没有 TOKEN 时使用）
var PASSWORD = "";   // 密码
// =======================================================

var TOKEN_KEY = "eoos_token";
var INPUT_KEY = "EOOS_TOKEN";

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

// ---------------- 基础工具 ----------------
function parse(str) { try { return JSON.parse(str); } catch (e) { return null; } }

function storeRead(key) {
  try { return (typeof $persistentStore !== "undefined" && $persistentStore.read(key)) || ""; } catch (e) { return ""; }
}
function storeWrite(key, value) {
  try { if (typeof $persistentStore !== "undefined") $persistentStore.write(value, key); } catch (e) {}
}

function headerValue(headers, name) {
  if (!headers) return "";
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return "";
}

// ---------------- 抓取模式：从页面请求里拿 token ----------------
if (typeof $request !== "undefined") {
  try {
    var auth = headerValue($request.headers, "Authorization");
    var m = /^Bearer\s+(.+)$/i.exec(auth || "");
    if (m && m[1]) {
      var fresh = m[1].trim();
      var had = storeRead(TOKEN_KEY);
      storeWrite(INPUT_KEY, fresh);
      storeWrite(TOKEN_KEY, fresh);
      console.log("[EOOS] 已抓取登录令牌，长度 " + fresh.length + (had === fresh ? "（未变化）" : "（已更新）"));
    }
  } catch (e) {}
  $done({});
} else {
  main();
}

// ---------------- HTTP ----------------
function http(method, path, body, token, cb) {
  var opt = {
    url: BASE + path,
    headers: {
      "Origin": BASE,
      "Referer": BASE + "/dashboard",
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*"
    }
  };
  if (token) opt.headers["Authorization"] = "Bearer " + token;
  if (body != null) {
    opt.body = JSON.stringify(body);
    opt.headers["Content-Type"] = "application/json";
  }
  var fn = method === "GET" ? $httpClient.get : $httpClient.post;
  fn(opt, function (err, resp, data) {
    if (err) return cb(err);
    cb(null, {
      status: (resp && resp.status) || 0,
      body: data != null ? data : ((resp && resp.body) || "")
    });
  });
}

function finish(title, subtitle, body) {
  console.log("[EOOS] " + title + " | " + subtitle + " | " + body);
  $notification.post("EOOS 签到 · " + title, subtitle || "", body || "");
  $done();
}

// ---------------- 登录（兜底） ----------------
function readArgument() {
  try { return (typeof $argument !== "undefined" && $argument) ? parse(String($argument)) : null; } catch (e) { return null; }
}

function login(cb) {
  if (!USERNAME || !PASSWORD) return cb("没有保存的令牌，且未配置账号密码");
  http("POST", "/api/auth/login", { userName: USERNAME, password: PASSWORD }, null, function (err, resp) {
    if (err) return cb("登录请求失败：" + err);
    var out = parse(resp.body);
    if (out && out.token) {
      storeWrite(INPUT_KEY, out.token);
      storeWrite(TOKEN_KEY, out.token);
      return cb(null, out.token);
    }
    cb("登录失败：" + ((out && out.message) || ("HTTP " + resp.status)));
  });
}

function resolveToken(cb) {
  var arg = readArgument();
  var token = TOKEN || (arg && arg.token) || storeRead(INPUT_KEY) || storeRead(TOKEN_KEY);
  if (token) return cb(null, token);
  if (arg && arg.username && arg.password) {
    USERNAME = arg.username;
    PASSWORD = arg.password;
  }
  login(cb);
}

// ---------------- 签到 ----------------
function solveCap(token, cb) {
  http("POST", "/api/cap/challenge", null, token, function (err, resp) {
    if (err) return cb("请求挑战失败：" + err);
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
    http("POST", "/api/cap/redeem", { token: data.token, solutions: solutions }, token, function (e2, r2) {
      if (e2) return cb("兑换请求失败：" + e2);
      var out = parse(r2.body);
      if (!out || !out.success || !out.token) return cb("兑换失败：" + ((out && out.message) || r2.body));
      cb(null, out.token);
    });
  });
}

function checkin(token, retried, cb) {
  http("GET", "/api/checkin/status", null, token, function (err, resp) {
    if (err) return cb("查询失败：" + err);

    if (resp.status === 401) {
      if (!retried && (USERNAME && PASSWORD)) {
        return login(function (lerr, newToken) {
          if (lerr) return cb(lerr);
          checkin(newToken, true, cb);
        });
      }
      return cb("令牌已失效，请在浏览器重新打开 eoos.top 让脚本自动抓取");
    }

    var st = parse(resp.body);
    if (!st || st.success !== true) return cb("状态异常：" + ((st && st.message) || resp.body));
    if (st.hasCheckedInToday) {
      return cb(null, "今日已签到", "本次获得 " + (st.amount || 0) + " " + (st.currencyUnit || "RCoin"));
    }

    solveCap(token, function (capErr, verificationToken) {
      if (capErr) return cb(capErr);
      http("POST", "/api/checkin", verificationToken ? { verificationToken: verificationToken } : {}, token, function (e3, r3) {
        if (e3) return cb("签到请求失败：" + e3);
        var out = parse(r3.body);
        if (out && out.success) {
          var line = "本次获得 " + (out.amount || 0) + " " + (out.currencyUnit || "RCoin");
          if (out.balance != null) line += "，余额 " + out.balance;
          return cb(null, "签到成功", line);
        }
        if (r3.status === 400 && out && out.hasCheckedIn) {
          return cb(null, "今日已签到", "本次获得 " + (out.amount || 0) + " " + (out.currencyUnit || "RCoin"));
        }
        cb("签到失败：HTTP " + r3.status + " " + ((out && out.message) || r3.body));
      });
    });
  });
}

// ---------------- 定时入口 ----------------
function main() {
  resolveToken(function (err, token) {
    if (err) return finish("未就绪", err, "先在浏览器打开一次 eoos.top");
    checkin(token, false, function (err2, title, detail) {
      if (err2) return finish("执行失败", err2, "");
      finish(title, detail, "");
    });
  });
}
