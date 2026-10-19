import { EventEmitter } from 'node:events'

// In-process event bus. index.js forwards every 'event' to SSE clients; notify.js listens for inbox items.
export const bus = new EventEmitter()
bus.setMaxListeners(100)

// type: 'project' | 'agent' | 'order' | 'task' | 'message' | 'activity' | 'inbox' | 'run'
export function emit(type, project_id, data = {}) {
  bus.emit('event', { type, project_id, data })
}
