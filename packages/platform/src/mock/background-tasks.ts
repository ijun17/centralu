import type { BackgroundTask, NormalizedEvent } from '@cc/protocol/client'
import { applyBackgroundTasks } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** Each session's background tasks (#290) and the calls that stop them */
export class BackgroundTasksMock {
  private backgroundTasks = new Map<string, BackgroundTask[]>()
  backgroundOf(sessionId: string): BackgroundTask[] {
    return this.backgroundTasks.get(sessionId) ?? []
  }
  readonly stoppedTasks: string[] = []
  readonly interrupts: string[] = []

  /** Through `applyBackgroundTasks`, as the host keeps them */
  track(event: NormalizedEvent): void {
    if (event.type === 'background_tasks') this.backgroundTasks.set(event.sessionId, applyBackgroundTasks(this.backgroundOf(event.sessionId), event))
  }

  readonly agents: Pick<AgentPort, 'interrupt' | 'stopBackgroundTask' | 'clearBackgroundTasks'> = {
    // As a real tool does (#290, measured): an interrupt stops only the tasks that stop with the turn
    interrupt: async (sessionId: string) => {
      this.interrupts.push(sessionId)
      const live = this.backgroundOf(sessionId).filter((t) => t.status === 'running')
      const stops = live.filter((t) => t.stopsWithTurn === true)
      if (stops.length > 0) {
        this.emit({
          type: 'background_tasks',
          sessionId,
          live: live.filter((t) => t.stopsWithTurn !== true),
          ended: stops.map((t) => ({ ...t, status: 'stopped' as const, summary: 'Stopped with the turn' })),
        })
      }
      this.emit({ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' })
    },
    /** As the host: the ending arrives as an event */
    stopBackgroundTask: async (sessionId: string, taskId: string) => {
      const live = this.backgroundOf(sessionId).filter((t) => t.status === 'running')
      const task = live.find((t) => t.id === taskId)
      if (!task) throw mockError('That background task is no longer running')
      if (!task.stoppable) throw mockError('This task cannot be stopped on its own')
      this.stoppedTasks.push(taskId)
      this.emit({ type: 'background_tasks', sessionId, live: live.filter((t) => t.id !== taskId), ended: [{ ...task, status: 'stopped' }] })
    },
    clearBackgroundTasks: async (sessionId: string) => {
      this.emit({ type: 'background_tasks', sessionId, live: this.backgroundOf(sessionId).filter((t) => t.status === 'running'), clearEnded: true })
    },
  }

  constructor(
    private readonly emit: Emit,
  ) {}
}
