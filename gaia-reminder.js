// 盖雅打卡提醒（只做提醒，不自动打卡）
// 本脚本不读取、不重放任何 Cookie / Bearer / 签名 / 位置 / 照片，
// 也不发起任何考勤请求，仅发送本地提醒通知。
let arg = String($argument || "clock-in").trim();

function notify(title, subtitle, body) {
  $notification.post(title, subtitle, body);
}

if (arg === "selftest") {
  notify("盖雅提醒自检", "脚本已加载", "定时提醒已就绪：08:20 上班、18:00 下班");
} else if (arg === "clock-out") {
  notify("盖雅打卡提醒", "下班打卡", "请在盖雅 App 内完成下班打卡");
} else {
  notify("盖雅打卡提醒", "上班打卡", "请在盖雅 App 内完成上班打卡");
}

$done();
