/* ============================================================
   ThreadThink — AI API Client (streaming)
   ============================================================ */

export function callAI(messages, config, onChunk) {
  return new Promise(function (resolve, reject) {
    if (!config.apiKey) { reject(new Error('请设置 API Key')); return; }
    var isAnthropic = config.apiBase.indexOf('anthropic.com') !== -1;
    var body;
    if (isAnthropic) {
      var am = []; for (var i = 0; i < messages.length; i++) am.push({ role: messages[i].role, content: messages[i].content });
      body = { model: config.model, max_tokens: 4096, system: config.systemPrompt, messages: am, stream: true };
    } else {
      var om = [{ role: 'system', content: config.systemPrompt }];
      for (var j = 0; j < messages.length; j++) om.push({ role: messages[j].role, content: messages[j].content });
      body = { model: config.model, max_tokens: 4096, messages: om, stream: true };
    }
    var headers = { 'Content-Type': 'application/json' };
    if (isAnthropic) { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else { headers['Authorization'] = 'Bearer ' + config.apiKey; }
    fetch(config.apiBase, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { reject(new Error('API ' + r.status + ': ' + t.slice(0, 200))); });
        var reader = r.body.getReader(), dec = new TextDecoder(), full = '', buf = '';
        function pump() {
          reader.read().then(function (v) {
            if (v.done) { resolve(full); return; }
            buf += dec.decode(v.value, { stream: true });
            var lines = buf.split('\n'); buf = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var ln = lines[i].trim();
              if (!ln || ln.indexOf('data: ') !== 0) continue;
              var d = ln.slice(6); if (d === '[DONE]') continue;
              try {
                var json = JSON.parse(d), chunk = '';
                if (isAnthropic) { if (json.type === 'content_block_delta' && json.delta && json.delta.text) chunk = json.delta.text; }
                else { var delta = json.choices && json.choices[0] && json.choices[0].delta; if (delta && delta.content) chunk = delta.content; }
                if (chunk) { full += chunk; onChunk(full); }
              } catch (e) {}
            }
            pump();
          }).catch(reject);
        }
        pump();
      }).catch(reject);
  });
}
