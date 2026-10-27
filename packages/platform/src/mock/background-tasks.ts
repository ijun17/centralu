import type { BackgroundTask, NormalizedEvent } from '@cc/protocol/client'
import { applyBackgroundTasks } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** Each session's background tasks (#290) and the calls that stop them */
export class BackgroundTasksMock {
  /** Each session's background tasks (#290), kept the way the host keeps them — through `applyBackgroundTasks` */
  private backgroundTasks = new Map<string, BackgroundTask[]>()
  backgroundOf(sessionId: string): BackgroundTask[] {
    return this.backgroundTasks.get(sessionId) ?? []
  }
  /** Background tasks a test saw stopped one by one, and the sessions it interrupted (#290) */
  readonly stoppedTasks: string[] = []
  readonly interrupts: string[] = []

  /** Keeps what a `background_tasks` event says, the way the host does */
  track(event: NormalizedEvent): void {
    if (event.type === 'background_tasks') this.backgroundTasks.set(event.sessionId, applyBackgroundTasks(this.backgroundOf(event.sessionId), event))
  }

  readonly agents: Pick<AgentPort, 'interrupt' | 'stopBackgroundTask' | 'clearBackgroundTasks'> = {
    /*
     * Like a real tool (#290, measured): an interrupt ends the background tasks that stop with the turn, as stopped,
     * and leaves the rest running.
     */
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
    /** Like the host: only a running, stoppable task is asked for, and its ending arrives as an event */
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
