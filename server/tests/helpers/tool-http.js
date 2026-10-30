import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Native request fixture: never opens a socket. Exposes the actual lookup handed
// to the transport and destruction of both request and response for assertions.
export function mockHttp(options) {
  var opts = options || {};
  var calls = [];
  function request(url, settings, onResponse) {
    var req = new EventEmitter();
    req.destroyed = false;
    var response = new PassThrough();
    response.statusCode = opts.status || 200;
    response.statusMessage = opts.statusMessage || 'OK';
    response.headers = opts.headers || { 'content-type': 'text/html' };
    var call = { url: url, options: settings, request: req, response: response };
    calls.push(call);
    req.destroy = function () { req.destroyed = true; response.destroy(); };
    req.end = function () {
      queueMicrotask(function () {
        if (req.destroyed) return;
        if (opts.error) { req.emit('error', opts.error); return; }
        onResponse(response);
        if (opts.onResponse) opts.onResponse(call);
        if (response.destroyed || opts.stall) return;
        for (var chunk of opts.chunks || [opts.body === undefined ? '<title>Example</title><p>Hello</p>' : opts.body]) {
          if (response.destroyed) break;
          response.write(chunk);
        }
        if (!response.destroyed) response.end();
      });
    };
    return req;
  }
  return { request: request, calls: calls };
}
