import { hiddenKind } from './linked-machine-connection.js'
import { Qualifier } from './qualifier.js'
import { Router, type RoutedMachine } from './router.js'

/** A linked machine that records what reached it and answers from a table */
export class FakeMachine implements RoutedMachine {
  readonly q: Qualifier
  reachable = true
  waitsForPerson = false
  calls: { method: string; params: unknown }[] = []
  timeouts: Record<string, number | undefined> = {}
  answers: Record<string, unknown> = {}
  mirror: Record<'sessions' | 'projects', unknown[] | null> = { sessions: null, projects: null }
  constructor(
    readonly id: string,
    slot: number,
    readonly name = `Machine ${id}`,
  ) {
    this.q = new Qualifier(id, slot)
  }
  async call(method: string, params: unknown, timeoutMs?: number) {
    this.calls.push({ method, params })
    this.timeouts[method] = timeoutMs
    const a = this.answers[method]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : (a ?? { ok: true })
  }
  lastKnown(kind: 'sessions' | 'projects') {
    return this.mirror[kind]
  }
  observe(kind: 'sessions' | 'projects', list: unknown[]) {
    this.mirror[kind] = list
  }
  // The rule a real machine connection hides by
  hides(s: unknown) {
    return hiddenKind(s)
  }
}

export function rig() {
  const local: { method: string; params: unknown }[] = []
  const localAnswers: Record<string, unknown> = {}
  const m1 = new FakeMachine('m1', 1)
  const m2 = new FakeMachine('m2', 2)
  const router = new Router({
    local: async (method, params) => {
      local.push({ method, params })
      return localAnswers[method] ?? { ok: true, from: 'hub' }
    },
    machines: () => [m1, m2],
  })
  return { router, local, localAnswers, m1, m2 }
}
