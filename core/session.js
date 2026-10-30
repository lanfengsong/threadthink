import { randomUUID } from 'node:crypto';

/** In-memory append-only event store; callers may export/import a JSON snapshot. */
export class Session {
  constructor(snapshot = {}) {
    this.id = snapshot.id || randomUUID();
    this._events = [];
    if (!Array.isArray(snapshot.events || [])) throw new TypeError('Session events 必须是数组');
    for (var event of snapshot.events || []) {
      if (event.seq !== this._events.length + 1 || typeof event.type !== 'string' || !event.payload || typeof event.payload !== 'object') throw new TypeError('Session event 无效');
      this._events.push(structuredClone(event));
    }
  }
  append(type, payload, traceId) {
    var event = { seq: this._events.length + 1, type, payload: structuredClone(payload), traceId: traceId || null, timestamp: new Date().toISOString() };
    this._events.push(event);
    return structuredClone(event);
  }
  get events() { return structuredClone(this._events); }
  messages({ kind = 'chat', upTo = Infinity } = {}) {
    return this._events.filter(event => event.seq <= upTo && ['user_message', 'ai_message'].includes(event.type) && (event.payload.kind || 'chat') === kind).map(event => ({ ...structuredClone(event.payload), seq: event.seq }));
  }
  status() {
    var messages = this.messages();
    return { id: this.id, eventCount: this._events.length, messageCount: messages.length, annotationMessageCount: this.messages({ kind: 'annotation' }).length, lastSeq: this._events.length, lastTermination: this._events.findLast(event => event.type === 'done')?.payload.termination || null };
  }
  toJSON() { return { version: 1, id: this.id, events: this.events }; }
}
