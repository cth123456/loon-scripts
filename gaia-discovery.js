/* Loon Gaia ingress discovery: report hosts and endpoint names only. */
(function () {
  var version = '1.0.0';
  var storeKey = 'gaiaDiscoverySeenV1';
  function notify(title, subtitle, body) {
    if (typeof $notification !== 'undefined') {
      $notification.post(String(title), String(subtitle), String(body));
    }
  }
  function readSeen() {
    if (typeof $persistentStore === 'undefined') return [];
    try {
      var value = $persistentStore.read(storeKey);
      var parsed = value ? JSON.parse(value) : [];
      return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
    } catch (_) {
      return [];
    }
  }
  function writeSeen(items) {
    if (typeof $persistentStore !== 'undefined') {
      $persistentStore.write(JSON.stringify(items.slice(0, 20)), storeKey);
    }
  }
  try {
    if (typeof $request === 'undefined') {
      notify('盖雅入口发现自检', '脚本已加载 v' + version, '此通知只验证脚本下载与运行');
      console.log('[GaiaDiscovery] self-test v' + version);
      return;
    }
    var url = String($request.url || '');
    var hostMatch = /^https?:\/\/([^/:]+)/i.exec(url);
    var endpointMatch = /\/api\/v1\/deviceCloud\/app\/([^/?#]+)/i.exec(url);
    var host = hostMatch ? hostMatch[1].toLowerCase() : 'unknown-host';
    var endpoint = endpointMatch ? endpointMatch[1] : 'other-traffic';
    var signature = host + '|' + endpoint;
    var seen = readSeen();
    if (seen.indexOf(signature) < 0) {
      seen.push(signature);
      writeSeen(seen);
      notify('盖雅流量已进入 Loon', host, '接口类别：' + endpoint);
    }
    console.log('[GaiaDiscovery] ' + JSON.stringify({
      version: version,
      host: host,
      endpoint: endpoint
    }));
  } catch (_) {
    console.log('[GaiaDiscovery] diagnostic-error');
  } finally {
    $done({});
  }
}());
