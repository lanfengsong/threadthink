// Shared cooperative deadlines. Native I/O must observe signal; a deadline alone
// cannot terminate arbitrary synchronous JavaScript supplied by a trusted plugin.
export function createDeadline(parentSignal, timeoutMs) {
  var controller = new AbortController();
  var onAbort = function () { controller.abort(parentSignal.reason || new Error('操作已取消')); };
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  var timer = setTimeout(function () {
    var error = new Error('操作超时');
    error.code = 'TOOL_TIMEOUT';
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    abort: function (reason) { controller.abort(reason); },
    dispose: function () {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

export function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('操作已取消'));
  return new Promise(function (resolve, reject) {
    var onAbort = function () { reject(signal.reason || new Error('操作已取消')); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(function () {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function boundedTimeout(value, maximum) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : maximum;
}
