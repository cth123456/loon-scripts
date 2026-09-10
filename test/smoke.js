/* eslint-disable */
/**
 * 本地验证 agentrouter-checkin.js 的逻辑，不发起真实网络请求。
 *
 * 做法：先给 Node 注入 Loon 运行时全局量（$httpClient / $persistentStore /
 * $notification / $done / $argument），再加载脚本体，逐个场景调用 main()。
 * 脚本在 Node 下不会自动执行（见文件末尾的 module 判断）。
 *
 * 运行： node test/smoke.js
 */
const assert = require("assert");
const script = require("../agentrouter-checkin.js");

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
  return Math.floor(Date.now() / 1000);
}

const state = { logs: [], notifications: [], done: false, requests: [] };
let spec = {};

globalThis.$persistentStore = {
  read: (k) => (Object.prototype.hasOwnProperty.call(spec.store || {}, k) ? spec.store[k] : null),
  write: () => true,
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
  state.requests.push({ method, url: params.url, headers: params.headers, body: params.body });
  const handler = spec.responder && spec.responder[method];
  setTimeout(() => {
    if (!handler) return cb("unhandled " + method + " " + params.url);
    const h = handler(params, state);
    if (!h) return cb(method + " handler 未返回");
    if (h.error) return cb(h.error);
    cb(null, h.resp, h.data);
  }, 0);
}

function reset(s) {
  spec = s;
  state.logs.length = 0;
  state.notifications.length = 0;
  state.requests.length = 0;
  state.done = false;
  if ("argument" in s) globalThis.$argument = s.argument;
  else delete globalThis.$argument;
}

const CASES = [
  {
    name: "happy path：登录成功 + 日志确认（new）",
    spec: {
      store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" },
      responder: {
        post: () => loginOk(),
        get: (p) => {
          assert.strictEqual(p.url, "https://agentrouter.org/api/log/self?p=1&page_size=20");
          assert.strictEqual(p.headers["New-API-User"], "42");
          return logResp([{ content: "签到成功", type: 4, created_at: nowSec() }]);
        },
      },
    },
    expect: {
      title: "[AgentRouter] 签到汇总",
      content: ["✅", "签到成功，日志已确认", "额度 12345"],
      logs: ["已读取 AGENTROUTER_ACCOUNT", "✅ 成功"],
    },
  },
  {
    name: "checked_in=false：登录成功但今日额度已发",
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" }, responder: { post: () => loginOk({ checked_in: false }) } },
    expect: { title: "[AgentRouter] 签到汇总", content: ["checked_in=false"] },
  },
  {
    name: "日志接口 500：核验失败但不影响登录结论（仍 success）",
    spec: {
      store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" },
      responder: { post: () => loginOk(), get: () => ({ resp: { status: 500, headers: {} }, data: "" }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["✅", "日志未确认", "HTTP 500"] },
  },
  {
    name: "登录接口返回 HTML（WAF）",
    spec: {
      store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" },
      responder: { post: () => ({ resp: { status: 200, headers: { "content-type": "text/html" } }, data: "<html>x</html>" }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "返回 HTML"] },
  },
  {
    name: "登录响应非 JSON",
    spec: {
      store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" },
      responder: { post: () => ({ resp: { status: 200, headers: {} }, data: "not json" }) },
    },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "非 JSON"] },
  },
  {
    name: "登录 success=false",
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" }, responder: { post: () => jsonResp(200, { success: false, message: "密码错误" }) } },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "登录失败", "密码错误"] },
  },
  {
    name: "网络异常：登录请求超时",
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" }, responder: { post: () => ({ error: "timeout" }) } },
    expect: { title: "[AgentRouter] 签到汇总", content: ["❌", "登录请求异常"] },
  },
  {
    name: "多账号 JSON + 旧格式兼容 + 额度分别取值",
    spec: {
      store: {
        AGENTROUTER_ACCOUNTS: JSON.stringify([
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
    expect: { title: "[AgentRouter] 签到汇总", content: ["✅ 甲", "✅ 乙", "额度 1", "额度 2"], logs: ["共 2 个"] },
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
    name: "安全性：127.0.0.1 被拒绝",
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA", AGENTROUTER_BASE_URL: "http://127.0.0.1:8080" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "安全性：localhost 被拒绝",
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA", AGENTROUTER_BASE_URL: "http://localhost:3000" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "安全性：192.168.x 内网被拒绝",
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA", AGENTROUTER_BASE_URL: "http://192.168.1.10" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "安全性：ftp:// 协议被拒绝",
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA", AGENTROUTER_BASE_URL: "ftp://agentrouter.org" }, responder: {} },
    expect: { title: "[AgentRouter] 签到失败", content: ["BASE_URL 不合法"] },
  },
  {
    name: "备用公网域名通过校验，URL 末尾斜杠被规范化",
    spec: {
      store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA", AGENTROUTER_BASE_URL: "https://ps.air-outer.com/" },
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
    spec: { store: { AGENTROUTER_ACCOUNT: "a@x.com#pwdA" }, responder: { post: () => loginOk({ checked_in: false }) } },
    runOnce: true,
    expect: { done: true, title: "[AgentRouter] 签到汇总" },
  },
];

function unitTests() {
  const t = [];
  const v = script.validateBaseUrl;
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

  t.push(["parseAccount 邮箱#密码", JSON.stringify(script.parseAccount("a@x.com#p#w")) === JSON.stringify(["a@x.com", "p#w"])]);
  t.push(["parseAccount 无密码", JSON.stringify(script.parseAccount("a@x.com")) === JSON.stringify(["a@x.com", ""])]);

  const q = script.extractQuota;
  t.push(["extractQuota quota", q({ quota: 5 }) === 5]);
  t.push(["extractQuota remainder_quota", q({ remainder_quota: 7 }) === 7]);
  t.push(["extractQuota balance", q({ balance: 9 }) === 9]);
  t.push(["extractQuota 无 → null", q({ x: 1 }) === null]);

  t.push(["humanAgo 秒", script.humanAgo(30) === "30 秒前"]);
  t.push(["humanAgo 分钟", script.humanAgo(120) === "2 分钟前"]);
  t.push(["humanAgo 天", script.humanAgo(90000) === "1 天前"]);

  t.push(["normalizeAccountsArray 丢弃不完整项", script.normalizeAccountsArray([{ account: "a@x.com#p" }, { account: "b@x.com" }]).length === 1]);
  t.push(["SCRIPT_VERSION 已定义且为 x.y.z", typeof script.SCRIPT_VERSION === "string" && /^\d+\.\d+\.\d+$/.test(script.SCRIPT_VERSION)]);
  return t;
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

  origLog("\n== 端到端（stub Loon 运行时）==");
  for (const c of CASES) {
    reset(c.spec);
    console.log = (...a) => state.logs.push(a.map(String).join(" "));
    let threw = null;
    try {
      if (c.runOnce) await script.runOnce();
      else await script.main();
    } catch (e) {
      threw = e;
    }
    console.log = origLog;

    const problems = [];
    const exp = c.expect || {};
    const logsAll = state.logs.join("\n");
    const note = state.notifications[0];

    if (threw) problems.push("main() 抛异常：" + (threw.message || threw));
    if (exp.title) {
      if (!note) problems.push("没有发出通知");
      else if (note.title !== exp.title) problems.push(`通知标题不匹配：期望「${exp.title}」实际「${note.title}」`);
    }
    if (exp.content && note) {
      for (const s of exp.content) if (String(note.content).indexOf(s) < 0) problems.push(`通知内容缺少「${s}」`);
    }
    if (exp.logs) for (const s of exp.logs) if (logsAll.indexOf(s) < 0) problems.push(`日志缺少「${s}」`);
    if (exp.done === true && state.done !== true) problems.push("未调用 $done()");

    if (problems.length) {
      fail++;
      origLog("❌ " + c.name);
      problems.forEach((p) => origLog("     - " + p));
    } else {
      pass++;
      origLog("✅ " + c.name);
    }
  }

  origLog(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
