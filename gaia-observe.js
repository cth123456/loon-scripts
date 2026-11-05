/* Loon http-request/http-response: observe structure, forward unchanged. */
(function () {
  var endpoints = [
    'getAttendancePunchConfig', 'MatchOptimalLocationInfo',
    'getUserDetermineAddressIsInRestriction',
    'SubmitEmployeeAttendanceDataByMAP', 'uploadEmployeeAttendanceFile'
  ];
  var headerNames = [
    'authorization', 'cookie', 'tenant', 'timestamp', 'app-nonce', 'sign',
    'content-type', 'x-origin', 'x-correlation-id', 'x-scene'
  ];
  var fields = [
    'personId', 'Longitude', 'Latitude', 'serverTime', 'Address',
    'hasImage', 'Remark', 'MachineID', 'overTime', 'locationFlag',
    'macsn', 'phoneModel', 'suspect', 'suspectReason', 'mobileSource',
    'osVersion', 'deviceCheck', 'sign', 'timeStamp', 'clockFlag',
    'locationInfo', 'imageFile', 'imageKey'
  ];
  function shape(raw) {
    if (typeof raw !== 'string') return { encoding: 'unavailable' };
    // Avoid parsing a large photo or emitting a server error body.
    if (raw.length > 8 * 1024 * 1024) return { encoding: 'over-limit' };
    var obj;
    try { obj = JSON.parse(raw); } catch (_) { return { encoding: 'not-json' }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { encoding: 'not-object' };
    }
    return {
      encoding: 'json',
      presentFields: fields.filter(function (key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
      }),
      hasImageKey: typeof obj.imageKey === 'string' && obj.imageKey.length > 0,
      successCode: ['0', '2', '4'].indexOf(String(obj.successCode)) >= 0
        ? String(obj.successCode) : 'other-or-absent',
      deviceCheck: typeof obj.deviceCheck === 'boolean' ? obj.deviceCheck : null
    };
  }
  try {
    if (typeof $request === 'undefined') return;
    var path = String($request.url || '').split('?')[0];
    var match = /\/api\/v1\/deviceCloud\/app\/([^/]+)(?:\/|$)/.exec(path);
    var endpoint = match && match[1];
    if (endpoints.indexOf(endpoint) < 0) return;
    var responsePhase = typeof $response !== 'undefined';
    var message = { phase: responsePhase ? 'response' : 'request', endpoint: endpoint };
    if (responsePhase) {
      var status = Number($response.status);
      message.httpStatus = status >= 100 && status <= 599 ? status : null;
      message.body = shape($response.body);
    } else {
      var headers = $request.headers || {};
      var names = Object.keys(headers).map(function (name) { return name.toLowerCase(); });
      message.presentHeaders = headerNames.filter(function (name) { return names.indexOf(name) >= 0; });
      message.body = shape($request.body);
    }
    console.log('[GaiaObserve] ' + JSON.stringify(message));
  } catch (_) {
    console.log('[GaiaObserve] diagnostic-error');
  } finally {
    $done({});
  }
}());
