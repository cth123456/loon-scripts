/* eslint-disable */
/**
 * AgentRouter 上游更新检查 —— Loon 版（cron 定时脚本）
 *
 * 背景：agentrouter.org 的签到逻辑来自上游 Python 脚本
 *   https://github.com/773075692/agentrouter-checkin/blob/main/agentrouter_checkin.py
 * Loon 只能跑 JavaScript，无法直接运行那份 .py，所以"跟随更新"只能是：
 *   上游一变 → 这里立刻通知你 → 按 README「重新移植」步骤更新我们的 JS。
 * 本脚本负责第一步：检查上游是否出现了我们还没移植的新提交。
 *
 * 判定基准是仓库里的 upstream-baseline.json（ported_sha 字段），
 * 每次重新移植后更新该文件，本脚本下个周期就会自动对齐。
 *
 * 运行频率建议每周一次（插件里默认 `0 10 * * 1`，周一 10:00）。
 * 只打两个固定地址：上游的 commits atom feed（github.com，无速率限制）
 * 和本仓库 main 的 upstream-baseline.json（raw.githubusercontent.com）。
 */

const UPSTREAM_REPO = "773075692/agentrouter-checkin";
const UPSTREAM_FILE = "agentrouter_checkin.py";
const UPSTREAM_BRANCH = "main";

// 单一事实来源：本仓库 main 的 baseline 文件（含 ported_sha）。
const BASELINE_URL =
  "https://raw.githubusercontent.com/cth123456/loon-scripts/main/upstream-baseline.json";

const STORE_NOTIFIED = "AGENTROUTER_UPSTREAM_NOTIFIED";
const TIMEOUT = 20000;

const SCRIPT_VERSION = "1.0.0";

const UA = "loon-scripts-upstream-watch";

function log(msg) {
  console.log("[AgentRouter上游检查] " + msg);
}

function notify(title, content) {
  try {
    $notification.post(title, "", String(content));
  } catch (e) {
    log("通知发送失败: " + e);
  }
}

function readStore(key) {
  try {
    return $persistentStore.read(key) || "";
  } catch (e) {
    return "";
  }
}

function writeStore(key, val) {
  try {
    return $persistentStore.write(String(val), key);
  } catch (e) {
    return false;
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

function request(method, params) {
  return new Promise(function (resolve, reject) {
    var fn = ($httpClient && $httpClient[method]) || null;
    if (!fn) {
      reject(new Error("当前环境不支持 $httpClient." + method));
      return;
    }
    fn.call($httpClient, params, function (err, resp, data) {
      if (err) reject(new Error(String(err)));
      else resolve({ resp: resp || {}, data: data });
    });
  });
}

function getJson(url, headers) {
  return request("get", {
    url: url,
    headers: headers || {},
    timeout: TIMEOUT,
    "auto-cookie": false
  });
}

// 上游提交源：用 GitHub 的 Atom feed 而不是 REST API。
// REST API 未认证时按 IP 限速（60 次/小时，共享出口/VPN 很容易触发 403），
// 而 commits 的 atom feed 没有这个限制，且同样带 SHA、标题和时间。
function upstreamFeedUrl() {
  return (
    "https://github.com/" +
    UPSTREAM_REPO +
    "/commits/" +
    UPSTREAM_BRANCH +
    "/" +
    UPSTREAM_FILE +
    ".atom"
  );
}

function unescapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

function tagText(block, tag) {
  var m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? unescapeXml(m[1]).replace(/\s+/g, " ").trim() : "";
}

// 解析 commits atom feed，返回第一条（最新）提交。
function parseLatestCommit(payload) {
  var xml = payload;
  if (xml && typeof xml === "object") return null;
  xml = String(xml || "");
  var m = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!m) return null;
  var entry = m[1];

  var idText = tagText(entry, "id");
  var shaMatch = idText.match(/([0-9a-f]{7,40})/i);
  var sha = shaMatch ? shaMatch[1] : "";
  if (!sha) {
    var linkMatch = entry.match(/\/commit\/([0-9a-f]{7,40})/i);
    sha = linkMatch ? linkMatch[1] : "";
  }
  if (!sha) return null;

  // 第一条 entry 的标题可能为空（合并提交），此时退回取 content 里的 <pre> 文本。
  var title = tagText(entry, "title");
  if (!title) {
    var pre = entry.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (pre) title = unescapeXml(pre[1]).replace(/\s+/g, " ").trim();
  }

  return {
    sha: sha,
    shortSha: sha.slice(0, 8),
    date: tagText(entry, "updated"),
    message: title,
    url: "https://github.com/" + UPSTREAM_REPO + "/commit/" + sha
  };
}

function parsePortedSha(payload) {
  var obj = payload;
  if (typeof payload === "string") {
    try {
      obj = JSON.parse(payload);
    } catch (e) {
      return "";
    }
  }
  return obj && typeof obj.ported_sha === "string" ? obj.ported_sha : "";
}

function compareUrl(fromSha, toSha) {
  if (!fromSha || !toSha) return "https://github.com/" + UPSTREAM_REPO + "/commits/" + UPSTREAM_BRANCH;
  return "https://github.com/" + UPSTREAM_REPO + "/compare/" + fromSha + "..." + toSha;
}

async function fetchLatest() {
  var r = await getJson(upstreamFeedUrl(), {
    Accept: "application/atom+xml, application/xml, text/xml, */*",
    "User-Agent": UA
  });
  if (r.resp.status !== 200) {
    throw new Error("上游 feed 返回 HTTP " + r.resp.status);
  }
  var latest = parseLatestCommit(r.data);
  if (!latest || !latest.sha) throw new Error("无法解析上游提交 feed");
  return latest;
}

async function fetchPortedSha() {
  try {
    var r = await getJson(BASELINE_URL + "?t=" + Math.floor(Date.now() / 1000), {
      "User-Agent": UA
    });
    if (r.resp.status !== 200) return "";
    return parsePortedSha(r.data);
  } catch (e) {
    return "";
  }
}

async function main() {
  log("upstream-watch v" + SCRIPT_VERSION + " 启动");

  var latest;
  try {
    latest = await fetchLatest();
  } catch (e) {
    log("上游查询失败: " + (e && e.message ? e.message : e));
    notify("AgentRouter 上游检查失败", "无法查询上游提交：" + (e && e.message ? e.message : e));
    return;
  }  log("上游最新提交: " + latest.shortSha + " " + latest.date + " " + latest.message);

  var ported = await fetchPortedSha();
  log("我们已移植的提交: " + (ported ? ported.slice(0, 8) : "(未取到 baseline)"));

  if (ported && latest.sha === ported) {
    log("已与上游对齐，无需处理");
    return;
  }

  var notified = readStore(STORE_NOTIFIED);
  if (notified === latest.sha) {
    log("该提交此前已提醒过，跳过重复通知");
    return;
  }

  var content;
  if (ported) {
    content =
      "上游有未移植的新提交：\n" +
      latest.shortSha +
      " " +
      latest.message +
      "\n（" +
      latest.date +
      "）\n\n对比：" +
      compareUrl(ported, latest.sha) +
      "\n\n处理：按 README「重新移植」步骤更新 agentrouter-checkin.js，并更新 upstream-baseline.json。";
  } else {
    content =
      "无法确认我们已移植的版本（baseline 读取失败）。\n上游最新：" +
      latest.shortSha +
      " " +
      latest.message +
      "\n" +
      (latest.url || compareUrl("", latest.sha));
  }

  notify("AgentRouter 上游脚本有更新", content);
  writeStore(STORE_NOTIFIED, latest.sha);
  log("已发送更新提醒");
}

function runOnce() {
  return main()
    .catch(function (e) {
      var m = e && e.message ? e.message : String(e);
      log("脚本异常: " + m);
      notify("AgentRouter 上游检查失败", "脚本异常: " + m);
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
    parseLatestCommit: parseLatestCommit,
    parsePortedSha: parsePortedSha,
    compareUrl: compareUrl,
    UPSTREAM_REPO: UPSTREAM_REPO,
    UPSTREAM_FILE: UPSTREAM_FILE
  };
}
