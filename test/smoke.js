/* eslint-disable */
/**
 * 本地验证 loon 脚本逻辑，不发起真实网络请求。
 *
 * 做法：先给 Node 注入 Loon 运行时全局量（$httpClient / $persistentStore /
 * $notification / $done / $argument / Date），再加载脚本，逐个场景调用 main()。
 * 脚本在 Node 下不会自动执行（见各文件末尾的 module 判断）。
 *
 * 运行： node test/smoke.js
 */
const assert = require("assert");
const checkin = require("../agentrouter-checkin.js");
const watch = require("../upstream-watch.js");

// ------------------------------------------------------------ mock 基础设施
const F = {
  EMAIL: checkin.FIELD_EMAIL,
  PASSWORD: checkin.FIELD_PASSWORD,
  ACCOUNT: checkin.FIELD_ACCOUNT,
  ACCOUNTS: checkin.FIELD_ACCOUNTS,
  BASE_URL: checkin.FIELD_BASE_URL,
  RUN_HOURS: "签到时间点[可留空]", // 历史持久化键，仅供回归测试
  NODE: checkin.FIELD_NODE,
};
const state = { logs: [], notifications: [], done: false, requests: [], store: {} };
let spec = {};
let clock = 0;
const RealDate = Date;
const realSetTimeout = globalThis.setTimeout;

function jsonResp(status, obj, headers) {
  return {
    resp: { status: status || 200, headers: Object.assign({ "content-type": "application/json" }, headers || {}) },
    data: JSON.stringify(obj),
  };
}
function loginOk(over) {
  return jsonResp(200, {
    success: true,
    data: Object.assign({ checked_in: true, username: "甲", quota: 12345, id: 42 }, over || {}),
  });
}
function logResp(items) {
  return jsonResp(200, { success: true, data: { items: items || [] } });
}
function nowSec() {
  return Math.floor(RealDate.now() / 1000);
}
function FakeDate(hour) {
  return class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(1789000000000); // 固定时间戳，仅用 getHours 覆盖
    }
    getHours() {
      return hour;
    }
  };
}

globalThis.$persistentStore = {
  read: (k) => (Object.prototype.hasOwnProperty.call(state.store, k) ? state.store[k] : null),
  write: (val, k) => {
    state.store[k] = String(val);
    return true;
  },
};
globalThis.$notification = {
  post: (title, subtitle, content) => state.notifications.push({ title, subtitle, content }),
};
globalThis.$done = () => {
  state.done = true;
};
globalThis.$httpClient = {
  get: (params, cb) => dispatch("get", params, cb),
  post: (params, cb) => dispatch("post", params, cb),
};

function dispatch(method, params, cb) {
  state.requests.push({ method, url: params.url, headers: params.headers, body: params.body, node: params.node, timeout: params.timeout });
  if (/agentrouter.org/.test(params.url)) assert(params.timeout > 0 && params.timeout <= 20000);
  if (spec.hangPost && method === "post") return;
  if (spec.advance) clock += Math.min(spec.advance, params.timeout);
  const seq = method === "post" ? spec.postSeq : null;
  const handler = (spec.responder && spec.responder[method]) || null;
  realSetTimeout(() => {
    // postSeq：按调用顺序依次返回（用于验证重试逻辑）
    if (seq && seq.length) {
      const h = seq.length > 1 ? seq.shift() : seq[0];
      if (!h) return cb(method + " postSeq 未返回");
      if (h.error) return cb(h.error);
      return cb(null, h.resp, h.data);
    }
    if (!handler) return cb("unhandled " + method + " " + params.url);
    const h = handler(params, state);
    if (!h) return cb(method + " handler 未返回");
    if (h.error) return cb(h.error);
    cb(null, h.resp, h.data);
  }, 0);
}

function reset(s) {
  spec = s;
  if (s.postSeq) spec = Object.assign({}, s, { postSeq: s.postSeq.slice() });
  state.logs.length = 0;
  state.notifications.length = 0;
  state.requests.length = 0;
  state.done = false;
  state.store = Object.assign({}, s.store || {});
  if ("argument" in s) globalThis.$argument = s.argument;
  else delete globalThis.$argument;
  globalThis.Date = "hour" in s ? FakeDate(s.hour) : RealDate;
  // 脚本内的 sleep 走全局 setTimeout：测试时改成 0 延迟，避免等待重试退避
  globalThis.setTimeout = (fn, ms) => {
    // 退避虚拟推进时间；请求 watchdog 不提前触发正常回调。
    if (fn.name !== "requestWatchdog") {
      clock += ms;
      return realSetTimeout(fn, 0);
    }
    return realSetTimeout(fn, s.watchdog ? 5 : ms);
  };
  clock = RealDate.now();
  state.startedAt = clock;
  globalThis.Date = class extends ("hour" in s ? FakeDate(s.hour) : RealDate) {
    static now() { return clock; }
  };
}

// ============================================================ 签到脚本用例
const CHECKIN_CASES = [
  {
    name: "happy path：登录成功 + 日志确认（new）",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: {
        post: () => loginOk(),
        get: (p) => {
          if (/\/login$/.test(p.url)) {
            return { resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>login page</html>" };
          }
          assert.strictEqual(p.url, "https://agentrouter.org/api/log/self?p=1&page_size=20");
          assert.strictEqual(p.headers["New-API-User"], "42");
          return logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]);
        },
      },
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["✅", "签到成功，日志已确认", "额度 12345"],
      logs: ["已读取「" + F.ACCOUNT + "」", "会话预热: GET /login -> HTTP 200", "✅ 成功"],
    },
  },
  {
    name: "WAF 重试：首次 POST 返回 HTML、重试拿到 JSON → 最终成功",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: {
        get: (p) =>
          /\/login$/.test(p.url)
            ? { resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>waf</html>" }
            : logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]),
        post: null, // 由下方 postSeq 覆盖
      },
      postSeq: [
        { resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html><title>拦截</title>blocked</html>" },
        loginOk(),
      ],
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["✅"],
      logs: ["第 1/10 次登录失败", "等待 8 秒后刷新会话重试"],
      postCount: 2,
      getCount: 3,
    },
  },
  {
    name: "服务端 5xx（ALB 暂时不可用）：退避重试后成功",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: {
        get: (p) =>
          /\/login$/.test(p.url)
            ? { resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>login</html>" }
            : logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]),
      },
      postSeq: [
        {
          resp: { status: 503, headers: { "content-type": "text/html" } },
          data: "<html><head><title>503 Service Temporarily Unavailable</title></head><body><center>alb</center></body></html>",
        },
        loginOk(),
      ],
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["✅"],
      logs: ["第 1/10 次登录失败: 服务端暂时不可用(HTTP 503)", "等待 8 秒后刷新会话重试"],
    },
  },
  {
    name: "服务端持续 5xx：试满 10 次后结束",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: {
        get: (p) =>
          /\/login$/.test(p.url)
            ? { resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>login</html>" }
            : { resp: { status: 200, headers: {} }, data: "" },
        post: () => ({
          resp: { status: 503, headers: { "content-type": "text/html" } },
          data: "<html><head><title>503 Service Temporarily Unavailable</title></head><body><center>alb</center></body></html>",
        }),
      },
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["❌", "连续 10 次登录未成功：服务端暂时不可用(HTTP 503)"],
      logs: ["第 10/10 次登录失败: 服务端暂时不可用(HTTP 503)"],
      postCount: 10,
    },
  },
  {
    name: "持续被 WAF 拦截：保留标题但不输出正文",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: {
        get: (p) =>
          /\/login$/.test(p.url)
            ? { resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>waf</html>" }
            : { resp: { status: 200, headers: {} }, data: "" },
        post: () => ({
          resp: { status: 200, headers: { "content-type": "text/html" } },
          data: "<html><head><title>安全拦截</title></head><body>您的请求被拦截</body></html>",
        }),
      },
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["❌", "连续 10 次登录未成功", "疑似被 WAF 拦截", "安全拦截"],
      logs: ["第 1/10 次登录失败: 登录接口返回 HTML(疑似被 WAF 拦截)", "第 10/10 次登录失败"],
      postCount: 10,
    },
  },
  {
    name: "预热返回验证页：不中止流程，POST 照常重试",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: {
        get: (p) =>
          /\/login$/.test(p.url)
            ? {
                resp: { status: 200, headers: { "content-type": "text/html" } },
                data: '<!doctype html><meta name="aliyun_waf_aa" content="x"><title></title>',
              }
            : { resp: { status: 200, headers: {} }, data: "" },
        post: () => ({
          resp: { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          data: '<!doctype html><meta charset="UTF-8"><meta name="aliyun_waf_aa" content="ff92"><meta name="aliyun_waf_bb" content="eade"><title></title>',
        }),
      },
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["❌", "连续 10 次登录未成功", "人机验证页"],
      postCount: 10,
      getCount: 10,
    },
  },
  {
    name: "指定节点：请求带上 node 参数",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.NODE]: "DIRECT" },
      responder: {
        get: (p) =>
          /\/login$/.test(p.url)
            ? { resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>login</html>" }
            : logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]),
        post: () => loginOk(),
      },
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      logs: ["本次请求将走节点/策略组: DIRECT"],
      allRequestsNode: "DIRECT",
    },
  },
  {
    name: "旧英文键 AGENTROUTER_ACCOUNT 仍可用，且迁移到中文键",
    spec: {
      store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" },
      responder: { post: () => loginOk({ checked_in: false }) },
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["checked_in=false"],
      logs: ["已将旧配置 AGENTROUTER_ACCOUNT 迁移到「" + F.ACCOUNT + "」"],
      storeHas: { [F.ACCOUNT]: "a@x.com#pwdA" },
    },
  },
  {
    name: "checked_in=false：登录成功但今日额度已发",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA" }, responder: { post: () => loginOk({ checked_in: false }) } },
    expect: { title: "[AgentRouter] 签到汇总", content: ["checked_in=false"] },
  },
  {
    name: "日志接口 500：核验失败但不影响登录结论（仍 success）",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: { post: () => loginOk(), get: () => ({ resp: { status: 500, headers: {} }, data: "" }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["✅", "日志未确认", "HTTP 500"] },
  },
  {
    name: "登录接口返回 HTML（WAF）：试满 10 次",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: { post: () => ({ resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>x</html>" }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "连续 10 次登录未成功", "返回 HTML"], postCount: 10 },
  },
  {
    name: "登录响应非 JSON：试满 10 次",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA" },
      responder: { post: () => ({ resp: { status: 200, headers: {} }, data: "not json" }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "连续 10 次登录未成功", "非 JSON"], postCount: 10 },
  },
  {
    name: "登录 success=false 且为凭据错误：首次即停",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA" }, responder: { post: () => jsonResp(200, { success: false, message: "密码错误" }) } },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "登录失败", "密码错误", "确定性失败"], postCount: 1 },
  },
  {
    name: "网络异常：登录请求超时",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA" }, responder: { post: () => ({ error: "timeout" }) } },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "登录请求异常"] },
  },
  {
    name: "多账号 JSON + 旧格式兼容 + 额度分别取值",
    spec: {
      store: {
        [F.ACCOUNTS]: JSON.stringify([
          { name: "甲", account: "a@x.com#pwdA" },
          { name: "乙", email: "b@x.com", password: "pwdB" },
        ]),
      },
      responder: {
        post: (p) => {
          const body = JSON.parse(p.body);
          return loginOk({ username: body.username, quota: body.username === "a@x.com" ? 1 : 2 });
        },
        get: () => logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]),
      },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["✅ 甲", "✅ 乙", "额度 1", "额度 2"], logs: ["已读取「" + F.ACCOUNTS + "」, 共 2 个"] },
  },
  {
    name: "脚本行 argument 单账号",
    spec: { argument: "a@x.com#pwdA", store: {}, responder: { post: () => loginOk(), get: () => logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]) } },
    expect: { title: "[AgentRouter] 签到汇总", logs: ["argument"] },
  },
  {
    name: "无任何配置",
    spec: { store: {}, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["未检测到账号配置"] },
  },
  {
    name: "旧中文小时未命中仍执行",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.RUN_HOURS]: "9,15,21" }, hour: 10, responder: { post: () => loginOk({ checked_in: false }) } },
    expect: { title: "[AgentRouter] 签到汇总", postCount: 1 },
  },
  {
    name: "时间次数：签到时间点=9,15,21 且当前 15 点 → 执行",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.RUN_HOURS]: "9,15,21" },
      hour: 15,
      responder: { post: () => loginOk({ checked_in: false }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["checked_in=false"] },
  },
  {
    name: "时间次数：区间 9-11，当前 10 点 → 执行",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.RUN_HOURS]: "9-11" },
      hour: 10,
      responder: { post: () => loginOk({ checked_in: false }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["checked_in=false"] },
  },
  {
    name: "时间次数：留空 → 不做限制，每次触发都执行",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.RUN_HOURS]: "" }, hour: 3, responder: { post: () => loginOk({ checked_in: false }) } },
    expect: { title: "[AgentRouter] 签到汇总", content: ["checked_in=false"] },
  },
  {
    name: "安全性：127.0.0.1 被拒绝",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.BASE_URL]: "http://127.0.0.1:8080" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "安全性：localhost 被拒绝",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.BASE_URL]: "http://localhost:3000" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "安全性：192.168.x 内网被拒绝",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.BASE_URL]: "http://192.168.1.10" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "安全性：ftp:// 协议被拒绝",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.BASE_URL]: "ftp://agentrouter.org" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "备用公网域名通过校验，URL 末尾斜杠被规范化",
    spec: {
      store: { [F.ACCOUNT]: "a@x.com#pwdA", [F.BASE_URL]: "https://ps.air-outer.com/" },
      responder: {
        post: (p) => {
          assert.strictEqual(p.url, "https://ps.air-outer.com/api/user/login");
          return loginOk({ checked_in: false });
        },
      },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["checked_in=false"] },
  },
  {
    name: "runOnce：运行时入口最终调用 $done()",
    spec: { store: { [F.ACCOUNT]: "a@x.com#pwdA" }, responder: { post: () => loginOk({ checked_in: false }) } },
    runOnce: true,
    expect: { done: true, title: "[AgentRouter] 签到汇总" },
  },
];

// 1.5.1 回归场景，所有 HTTP 均为 stub。
const accountStore = { [F.EMAIL]: "a#tag@example.com", [F.PASSWORD]: " p#a#ss " };
const warm = () => ({ resp: { status: 200, headers: {} }, data: "<html>login</html>" });
for (const [argument, hour] of [["", 18], ["manual", 18], ["scheduled", 18], ["", 3], ["", 5], ["", 10]]) {
  CHECKIN_CASES.push({
    name: `${argument} ${hour}点，配置3,5,10`,
    spec: { argument, hour, store: { ...accountStore, [F.RUN_HOURS]: "3,5,10" }, responder: {
      get: warm,
      post: (p) => {
        assert.deepStrictEqual(JSON.parse(p.body), { username: "a#tag@example.com", password: " p#a#ss " });
        return loginOk({ checked_in: false });
      },
    } },
    expect: { title: "[AgentRouter] 签到汇总", postCount: 1 },
  });
}
for (const [name, seq, expected] of [
  ["网络失败后成功", [{ error: "timeout" }, loginOk({ checked_in: false })], 2],
  ["第十次成功立即停止", [...Array(9).fill(jsonResp(503, {})), loginOk({ checked_in: false })], 10],
  ["JSON captcha 也重试", [...Array(9).fill(jsonResp(200, { success: false, message: "captcha required" })), loginOk()], 10],
  ["HTML captcha 也重试", [...Array(9).fill({ resp: { status: 503, headers: {} }, data: '<html>aliyun_waf_aa</html>' }), loginOk()], 10],
  ["明确密码错误不重试", [jsonResp(500, { success: false, message: "invalid credentials" }), loginOk()], 1],
  ["限流也重试", [...Array(9).fill(jsonResp(429, {})), loginOk()], 10],
  ["认证拒绝也重试", [...Array(9).fill(jsonResp(403, {})), loginOk()], 10],
]) {
  CHECKIN_CASES.push({ name, spec: { store: accountStore, responder: { get: warm }, postSeq: seq }, expect: { postCount: expected, title: "[AgentRouter] 签到汇总" } });
}
CHECKIN_CASES.push(
  { name: "普通预热HTML含captcha组件不误判挑战", spec: { store: accountStore, responder: { get: () => ({ resp: { status: 200, headers: {} }, data: '<html><script src="captcha-widget.js"></script></html>' }), post: () => loginOk({ checked_in: false }) } }, expect: { postCount: 1, content: ["checked_in=false"] } },
  { name: "旧英文小时值不影响18点执行且不迁移", spec: { argument: "scheduled", hour: 18, store: { ...accountStore, AGENTROUTER_RUN_HOURS: "3,5,10" }, responder: { get: warm, post: () => loginOk({ checked_in: false }) } }, expect: { postCount: 1, storeHas: { AGENTROUTER_RUN_HOURS: "3,5,10", [F.RUN_HOURS]: undefined } } },
  { name: "分开凭据优先于旧值", spec: { store: { ...accountStore, [F.ACCOUNT]: "old@example.com#old" }, responder: { get: warm, post: p => {
    assert.strictEqual(JSON.parse(p.body).password, " p#a#ss "); return loginOk({ checked_in: false });
  } } }, expect: { postCount: 1 } },
  { name: "分开凭据不完整不回退旧值", spec: { store: { [F.EMAIL]: "new@example.com", [F.ACCOUNT]: "old@example.com#old" } }, expect: { noRequests: true, title: "[AgentRouter] 签到失败" } },
  { name: "单账号慢响应受250秒预算限制", spec: { store: accountStore, advance: 10000, responder: { get: warm }, postSeq: [jsonResp(503, {})] }, expect: { postCount: 9, content: ["时间预算已耗尽"], maxElapsed: 260000 } },
  { name: "回调不返回 watchdog 停止不重试并done", runOnce: true, spec: { store: accountStore, watchdog: true, hangPost: true, responder: { get: warm } }, expect: { postCount: 1, done: true, content: ["回调超时"] } },
  { name: "多账号共享290秒预算，剩余明确未执行", spec: { store: { [F.ACCOUNTS]: JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ email: `a${i}@example.com`, password: "p" }))) }, advance: 10000, responder: { get: warm }, postSeq: [jsonResp(503, {})] }, expect: { content: ["整轮时间预算已耗尽，未执行"], maxElapsed: 300000 } },
  { name: "Cookie 跨失败与成功合并，核验保留session", spec: {
    store: accountStore,
    responder: { get: (function () { let warms = 0; return p => {
      if (/\/login$/.test(p.url)) {
        warms++;
        // 仅首次预热下发会话 cookie；后续刷新不再重发，验证 POST 后的 cookie 不被冲掉
        if (warms > 1) return { resp: { status: 200, headers: {} }, data: "<html>login</html>" };
        return { resp: { status: 200, headers: { 'Set-Cookie': ['acw_tc=old; Path=/', 'session=keep; Path=/'] } }, data: "<html>login</html>" };
      }
      assert.strictEqual(p.headers.Cookie, "acw_tc=new; session=keep; auth=ok");
      return logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]);
    }; })(), post: (p, s) => {
      if (s.requests.filter(r => r.method === "post").length === 1) return jsonResp(503, {}, { 'Set-Cookie': 'acw_tc=new; Path=/' });
      assert.strictEqual(p.headers.Cookie, "acw_tc=new; session=keep");
      const r = loginOk(); r.resp.headers['Set-Cookie'] = 'auth=ok; Path=/'; return r;
    } },
  }, expect: { postCount: 2, content: ["日志已确认"] } }
);

// ============================================================ 上游检查用例
const ATOM = (sha, msg, date) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n' +
  "  <entry>\n" +
  "    <id>tag:github.com,2008:Grit::Commit/" + sha + "</id>\n" +
  '    <link type="text/html" rel="alternate" href="https://github.com/x/y/commit/' + sha + '"/>\n' +
  "    <title>\n        " + msg + "\n    </title>\n" +
  "    <updated>" + date + "</updated>\n" +
  "  </entry>\n" +
  "  <entry>\n" +
  "    <id>tag:github.com,2008:Grit::Commit/older99</id>\n" +
  "    <title>older commit</title>\n" +
  "    <updated>2020-01-01T00:00:00Z</updated>\n" +
  "  </entry>\n" +
  "</feed>";
const baselinePayload = (sha) => JSON.stringify({ ported_sha: sha });

const WATCH_CASES = [
  {
    name: "上游与已移植版本一致 → 安静，不通知",
    spec: {
      responder: {
        get: (p) => (p.url.indexOf(".atom") >= 0 ? { resp: { status: 200, headers: {} }, data: ATOM("aaaa1111", "m", "2026-01-01T00:00:00Z") } : { resp: { status: 200, headers: {} }, data: baselinePayload("aaaa1111") }),
      },
    },
    expect: { noNotify: true, logs: ["已与上游对齐"] },
  },
  {
    name: "上游有新提交 → 通知并包含对比链接",
    spec: {
      responder: {
        get: (p) => (p.url.indexOf(".atom") >= 0 ? { resp: { status: 200, headers: {} }, data: ATOM("bbbb2222222222", "feat: 新功能", "2026-02-02T00:00:00Z") } : { resp: { status: 200, headers: {} }, data: baselinePayload("aaaa1111") }),
      },
    },
    expect: {
      title: "AgentRouter 上游脚本有更新",
      content: ["bbbb2222", "feat: 新功能", "compare/aaaa1111...bbbb2222222222"],
    },
  },
  {
    name: "同一新提交第二次运行 → 去重，不再通知",
    spec: {
      store: { AGENTROUTER_UPSTREAM_NOTIFIED: "bbbb2222222222" },
      responder: {
        get: (p) => (p.url.indexOf(".atom") >= 0 ? { resp: { status: 200, headers: {} }, data: ATOM("bbbb2222222222", "feat: 新功能", "2026-02-02T00:00:00Z") } : { resp: { status: 200, headers: {} }, data: baselinePayload("aaaa1111") }),
      },
    },
    expect: { noNotify: true, logs: ["此前已提醒过"] },
  },
  {
    name: "baseline 读取失败 → 退回提示但不算失败",
    spec: {
      responder: {
        get: (p) => (p.url.indexOf(".atom") >= 0 ? { resp: { status: 200, headers: {} }, data: ATOM("cccc3333", "fix", "2026-03-03T00:00:00Z") } : { resp: { status: 404, headers: {} }, data: "" }),
      },
    },
    expect: { title: "AgentRouter 上游脚本有更新", content: ["无法确认我们已移植的版本"] },
  },
  {
    name: "上游 feed 失败 → 发失败通知",
    spec: { responder: { get: () => ({ resp: { status: 403, headers: {} }, data: "" }) } },
    expect: { title: "AgentRouter 上游检查失败", content: ["HTTP 403"] },
  },
  {
    name: "runOnce：运行时入口最终调用 $done()",
    spec: {
      responder: {
        get: (p) => (p.url.indexOf(".atom") >= 0 ? { resp: { status: 200, headers: {} }, data: ATOM("aaaa1111", "m", "2026-01-01T00:00:00Z") } : { resp: { status: 200, headers: {} }, data: baselinePayload("aaaa1111") }),
      },
    },
    runOnce: true,
    expect: { done: true },
  },
];

// ============================================================ 纯函数单测
function unitTests() {
  const t = [];
  const v = checkin.validateBaseUrl;
  t.push(["默认公网 https 通过", v("https://agentrouter.org").ok === true]);
  t.push(["localhost 拒绝", v("http://localhost/x").ok === false]);
  t.push(["127.0.0.1 拒绝", v("http://127.0.0.1").ok === false]);
  t.push(["10.0.0.1 拒绝", v("http://10.0.0.1").ok === false]);
  t.push(["172.16.5.5 拒绝", v("http://172.16.5.5").ok === false]);
  t.push(["172.32.0.1 允许(非私网)", v("http://172.32.0.1").ok === true]);
  t.push(["169.254.1.1 拒绝", v("http://169.254.1.1").ok === false]);
  t.push(["100.64.0.1 拒绝(CGNAT)", v("http://100.64.0.1").ok === false]);
  t.push(["foo.local 拒绝", v("http://foo.local").ok === false]);
  t.push(["ftp 拒绝", v("ftp://x.com").ok === false]);
  t.push(["坏 URL 拒绝", v("not-a-url").ok === false]);

  t.push(["parseAccount 邮箱#密码", JSON.stringify(checkin.parseAccount("a@x.com#p#w")) === JSON.stringify(["a@x.com", "p#w"])]);
  t.push(["parseAccount 无密码", JSON.stringify(checkin.parseAccount("a@x.com")) === JSON.stringify(["a@x.com", ""])]);

  const q = checkin.extractQuota;
  t.push(["extractQuota quota", q({ quota: 5 }) === 5]);
  t.push(["extractQuota remainder_quota", q({ remainder_quota: 7 }) === 7]);
  t.push(["extractQuota balance", q({ balance: 9 }) === 9]);
  t.push(["extractQuota 无 → null", q({ x: 1 }) === null]);

  t.push(["humanAgo 秒", checkin.humanAgo(30) === "30 秒前"]);
  t.push(["humanAgo 分钟", checkin.humanAgo(120) === "2 分钟前"]);
  t.push(["humanAgo 天", checkin.humanAgo(90000) === "1 天前"]);

  t.push(["normalizeAccountsArray 丢弃不完整项", checkin.normalizeAccountsArray([{ account: "a@x.com#p" }, { account: "b@x.com" }]).length === 1]);
  t.push(["checkin SCRIPT_VERSION 为 x.y.z", /^\d+\.\d+\.\d+$/.test(checkin.SCRIPT_VERSION)]);
  t.push(["watch SCRIPT_VERSION 为 x.y.z", /^\d+\.\d+\.\d+$/.test(watch.SCRIPT_VERSION)]);


  const pc = watch.parseLatestCommit;
  t.push(["parseLatestCommit 取首条 entry 的 SHA", pc(ATOM("deadbeef1234", "msg here", "2026-05-05T00:00:00Z")).shortSha === "deadbeef"]);
  t.push(["parseLatestCommit 取标题", pc(ATOM("deadbeef1234", "hello world", "2026-05-05")).message === "hello world"]);
  t.push(["parseLatestCommit XML 实体解码", pc(ATOM("deadbeef1234", "a &amp; b &#39;c&#39;", "2026-05-05")).message === "a & b 'c'"]);
  t.push(["parseLatestCommit 坏输入 → null", pc("{not xml") === null]);
  t.push(["parseLatestCommit 空输入 → null", pc("") === null]);
  t.push(["parsePortedSha 正常", watch.parsePortedSha(baselinePayload("abc")) === "abc"]);
  t.push(["parsePortedSha 坏 JSON → 空", watch.parsePortedSha("{oops") === ""]);
  t.push(["compareUrl 含 from/to", /compare\/aaa\.\.\.bbb/.test(watch.compareUrl("aaa", "bbb"))]);
  t.push(["compareUrl 缺参数退回 commits 页", /\/commits\/main$/.test(watch.compareUrl("", "bbb"))]);

  // 输入项名称：必须是中文（用户能看懂），且不能含 `#`（会截断插件 #! 行）
  const fields = [checkin.FIELD_EMAIL, checkin.FIELD_PASSWORD, checkin.FIELD_ACCOUNTS, checkin.FIELD_BASE_URL];
  t.push(["输入项名称含中文字符", fields.every((f) => /[\u4e00-\u9fa5]/.test(f))]);
  t.push(["输入项名称不含 # ", fields.every((f) => f.indexOf("#") < 0)]);
  t.push(["输入项名称互不相同", new Set(fields).size === fields.length]);

  // WAF 诊断辅助
  t.push(["clip 截断加省略号", checkin.clip("abcdef", 3) === "abc…"]);
  t.push(["clip 短串不变", checkin.clip("ab", 5) === "ab"]);
  t.push(["clip 压缩空白", checkin.clip("a\n\n  b", 10) === "a b"]);
  t.push(["htmlTitle 抽取标题", checkin.htmlTitle("<html><title>安全拦截</title></html>") === "安全拦截"]);
  t.push(["htmlTitle 无标题 → 空", checkin.htmlTitle("<html>x</html>") === ""]);

  const ic = checkin.isCaptchaPage;
  t.push(["isCaptchaPage 命中 aliyun_waf_aa", ic('<meta name="aliyun_waf_aa" content="x">') === true]);
  t.push(["isCaptchaPage 命中 aliyun_waf_bb", ic('<meta name="aliyun_waf_bb" content="x">') === true]);
  t.push(["isCaptchaPage 命中 aliyunCaptcha", ic("AliyunCaptcha.js") === true]);
  t.push(["isCaptchaPage 命中 nc-container", ic('<div class="nc-container">') === true]);
  t.push(["isCaptchaPage 普通 HTML → false", ic("<html><body>hello</body></html>") === false]);
  t.push(["isCaptchaPage JSON → false", ic('{"success":false}') === false]);
  t.push(["isCaptchaPage 空 → false", ic("") === false]);

  const lh = checkin.loginHeaders("https://agentrouter.org");
  t.push(["loginHeaders 是 JSON 内容类型", lh["Content-Type"] === "application/json"]);
  t.push(["loginHeaders 带 Origin", lh.Origin === "https://agentrouter.org"]);
  t.push(["loginHeaders 带 Sec-Fetch-Mode", lh["Sec-Fetch-Mode"] === "cors"]);
  t.push(["loginHeaders 带浏览器 UA", /Chrome\//.test(lh["User-Agent"])]);
  t.push(["loginHeaders 无 cookie 时不带 Cookie", !("Cookie" in lh)]);
  t.push(["loginHeaders 有 cookie 时带上", checkin.loginHeaders("https://x.com", "a=1; b=2").Cookie === "a=1; b=2"]);

  const ec = checkin.extractCookies;
  t.push(["extractCookies 取 acw_tc", ec({ "set-cookie": "acw_tc=abc;path=/;HttpOnly" }) === "acw_tc=abc"]);
  t.push(["extractCookies 多 cookie 合并", ec({ "set-cookie": "a=1;path=/,b=2;path=/" }) === "a=1; b=2"]);
  t.push(["extractCookies 数组形式", ec({ "set-cookie": ["a=1;path=/", "b=2;path=/"] }) === "a=1; b=2"]);
  t.push(["extractCookies 大小写不敏感", ec({ "Set-Cookie": "x=9;path=/" }) === "x=9"]);
  t.push(["extractCookies 无 set-cookie → 空", ec({ "content-type": "application/json" }) === ""]);
  t.push(["extractCookies null → 空", ec(null) === ""]);
  t.push(["extractCookies 无等号的畸形头 → 空", ec({ "set-cookie": "novalue; a=1" }) === ""]);
  t.push(["extractCookies 忽略属性只留 name=value", ec({ "set-cookie": "sid=v; Path=/; HttpOnly; Max-Age=1800" }) === "sid=v"]);

  const fs = require("fs");
  const path = require("path");
  const plugin = fs.readFileSync(path.join(__dirname, "../AgentRouter.checkin.plugin"), "utf8");
  const mirror = fs.readFileSync(path.join(__dirname, "../AgentRouter.checkin.jsdelivr.plugin"), "utf8")
    .replace("（jsDelivr 镜像版）", "")
    .replaceAll("https://cdn.jsdelivr.net/gh/cth123456/loon-scripts@main/", "https://raw.githubusercontent.com/cth123456/loon-scripts/main/");
  t.push(["两份插件功能完全一致", plugin === mirror]);
  t.push(["插件每天3/5/10 cron且无generic", /cron "0 3,5,10 \* \* \*"/.test(plugin) && !/generic /.test(plugin)]);
  t.push(["插件与脚本版本1.5.2一致", checkin.SCRIPT_VERSION === "1.5.2" && plugin.includes("v1.5.2")]);
  t.push(["插件包含分开的中文输入", plugin.includes("#!input = " + F.EMAIL) && plugin.includes("#!input = " + F.PASSWORD)]);
  t.push(["Cookie同名更新保留其他值", checkin.mergeCookies("sid=1; waf=a", "waf=b; auth=x=y") === "sid=1; waf=b; auth=x=y"]);
  t.push(["Cookie Expires逗号不破坏分割", ec({ "set-cookie": "sid=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT, waf=b; Path=/" }) === "sid=1; waf=b"]);
  return t;
}

// ============================================================ 执行
async function runCase(c, mod, seclog) {
  reset(c.spec);
  const origLog = console.log;
  console.log = (...a) => state.logs.push(a.map(String).join(" "));
  let threw = null;
  try {
    if (c.runOnce) await mod.runOnce();
    else await mod.main();
  } catch (e) {
    threw = e;
  }
  console.log = origLog;
  return { threw };
}

function checkExpect(c, threw) {
  const problems = [];
  const exp = c.expect || {};
  const logsAll = state.logs.join("\n");
  const note = state.notifications[0];

  if (threw) problems.push("抛异常：" + (threw.message || threw));
  if (exp.noNotify && state.notifications.length) problems.push("不应发通知但发了：" + state.notifications[0].title);
  if (exp.title) {
    if (!note) problems.push("没有发出通知");
    else if (note.title !== exp.title) problems.push(`通知标题不匹配：期望「${exp.title}」实际「${note.title}」`);
  }
  if (exp.content && note) {
    for (const s of exp.content) if (String(note.content).indexOf(s) < 0) problems.push(`通知内容缺少「${s}」`);
  }
  if (exp.logs) for (const s of exp.logs) if (logsAll.indexOf(s) < 0) problems.push(`日志缺少「${s}」`);
  if (exp.maxElapsed && clock - state.startedAt > exp.maxElapsed) problems.push("超出时间预算");
  if (exp.done === true && state.done !== true) problems.push("未调用 $done()");
  if (exp.noRequests && state.requests.length) problems.push("不应发请求但发了 " + state.requests.length + " 个");
  if (exp.postCount !== undefined) {
    const posts = state.requests.filter((r) => r.method === "post").length;
    if (posts !== exp.postCount) problems.push(`POST 次数期望 ${exp.postCount} 实际 ${posts}`);
  }
  if (exp.getCount !== undefined) {
    const gets = state.requests.filter((r) => r.method === "get").length;
    if (gets !== exp.getCount) problems.push(`GET 次数期望 ${exp.getCount} 实际 ${gets}`);
  }
  if (exp.allRequestsNode) {
    const bad = state.requests.filter((r) => r.node !== exp.allRequestsNode);
    if (bad.length) problems.push(`${bad.length} 个请求没有带上 node=${exp.allRequestsNode}`);
  }
  if (exp.storeHas) {
    for (const k of Object.keys(exp.storeHas)) {
      if (state.store[k] !== exp.storeHas[k]) problems.push(`存储键「${k}」期望「${exp.storeHas[k]}」实际「${state.store[k]}」`);
    }
  }
  return problems;
}

(async function () {
  let pass = 0;
  let fail = 0;
  const origLog = console.log;

  origLog("== 纯函数单测 ==");
  for (const [name, ok] of unitTests()) {
    if (ok) {
      pass++;
      origLog("✅ " + name);
    } else {
      fail++;
      origLog("❌ " + name);
    }
  }

  const suites = [
    ["agentrouter-checkin.js", checkin, CHECKIN_CASES],
    ["upstream-watch.js", watch, WATCH_CASES],
  ];
  for (const [label, mod, cases] of suites) {
    origLog("\n== 端到端（stub Loon 运行时）· " + label + " ==");
    for (const c of cases) {
      const { threw } = await runCase(c, mod);
      const problems = checkExpect(c, threw);
      if (problems.length) {
        fail++;
        origLog("❌ " + c.name);
        problems.forEach((p) => origLog("     - " + p));
      } else {
        pass++;
        origLog("✅ " + c.name);
      }
    }
  }

  globalThis.Date = RealDate;
  origLog(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
