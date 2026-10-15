import type { NormalizedEvent } from '@cc/protocol'
import type { AgentPort, ConnectionState, Unsubscribe } from '../ports/index.js'

/** The mock's `emit`, handed to a module so it can broadcast without importing MockPlatform */
export type Emit = (event: NormalizedEvent) => void

/** Who listens to the mock: the event subscribers and the connection watchers (`agents.subscribe`, `onConnectionChange`) */
export class EventBus {
  private handlers = new Set<(e: NormalizedEvent) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()

  /** Hands one event on to every subscriber */
  broadcast(event: NormalizedEvent): void {
    for (const h of this.handlers) h(event)
  }

  setConnectionState(s: ConnectionState): void {
    for (const h of this.connHandlers) h(s)
  }

  async dispose(): Promise<void> {
    this.handlers.clear()
    this.connHandlers.clear()
  }
  readonly agents: Pick<AgentPort, 'subscribe' | 'onConnectionChange'> = {
    subscribe: (handler: (e: NormalizedEvent) => void): Unsubscribe => {
      this.handlers.add(handler)
      return () => this.handlers.delete(handler)
    },
    onConnectionChange: (handler: (s: ConnectionState) => void): Unsubscribe => {
      this.connHandlers.add(handler)
      return () => this.connHandlers.delete(handler)
    },
  }
}
