import { EventEmitter } from 'node:events';

// In-process event bus. The dashboard subscribes through Server-Sent Events (/api/events).
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emit(type, data = {}) {
  bus.emit('event', { type, data, at: new Date().toISOString() });
}
