/**
 * The asked gate when a turn holds requests of two sessions (docs/plans/turn-owned-by-no-one.md §4.2): the drain never makes one, and if one ever
 * came the gate fails closed. Nothing can tell whose request a step is for, so every step but a read asks, the answer in a request's thread and a
 * step that can be undone included, the card names every asker, and a step done is recorded in each.
 */
import { describe, expect, it } from 'vitest'
import type { Asker } from '../mail/asked-by.js'
import { AskedGate, type AskedGateHost } from './asked-gate.js'

const TWO: Asker = {
  messageId: 't1',
  sessionId: 'asker',
  turn: 1,
  name: 'Fix login',
  project: 'Acme',
  trusted: true,
  cites: { seq: 7, at: 1_000 },
  also: [{ sessionId: 'other', name: 'Docs', project: null, trusted: false }],
}

type Out = { text: string; isError?: boolean }
const refused = (text: string): Out => ({ text, isError: true })

function world(asker: () => Asker | null = () => TWO) {
  const asked: string[] = []
  const records: { asker: string; seq: number | null; act: string }[] = []
  const host: AskedGateHost = {
    askedBy: asker,
    ask: async (_id, question) => (asked.push(question), 'allow'),
    cover: async (_id, run) => run(),
    noLooser: () => true,
    done: (a, act) => void records.push({ asker: a.sessionId, seq: a.cites?.seq ?? null, act }),
  }
  return { gate: new AskedGate(host), asked, records }
}
const run = async (): Promise<Out> => ({ text: 'did it' })

describe('a turn with two askers fails closed (§4.2)', () => {
  it('a step that can be undone, and work handed on to a session no looser, ask: no asker can be checked against', async () => {
    const w = world()
    await w.gate.when('orc', { name: 'rename_session', args: { sessionId: 's', name: 'x' } }, undefined, run, refused)
    await w.gate.when('orc', { name: 'mail', args: { action: 'send', to: 's', text: 'go' } }, undefined, run, refused)
    expect(w.asked).toHaveLength(2)
  })

  it('the answer in a request’s thread asks too; reading and mail to the person do not', async () => {
    const w = world()
    await w.gate.when('orc', { name: 'mail', args: { action: 'reply', thread: 't1', text: 'done' } }, undefined, run, refused)
    expect(w.asked).toHaveLength(1)
    await w.gate.when('orc', { name: 'mail', args: { action: 'read', thread: 't1' } }, undefined, run, refused)
    await w.gate.when('orc', { name: 'mail', args: { action: 'send', to: 'person', text: 'which one?' } }, undefined, run, refused)
    expect(w.asked).toHaveLength(1)
    expect(await w.gate.askCli('orc', 'Bash', { command: 'git push' })).toMatchObject({ allowed: true, asked: true })
    expect(w.asked).toHaveLength(2)
  })

  it('the card names every asker, and a step done is recorded in each asking session', async () => {
    const w = world()
    await w.gate.when('orc', { name: 'delete_session', args: { sessionId: 's' } }, undefined, run, refused)
    expect(w.asked[0]).toContain('Sessions "Fix login" in project "Acme" and "Docs" with no project each asked the Assistant for something in this turn')
    expect(w.asked[0]).toContain('run delete_session')
    expect(w.records.map((r) => [r.asker, r.seq])).toEqual([
      ['asker', 7],
      ['other', null],
    ])
  })

  it('an Allow given while one asker was in the turn is not for a turn that has two by then', async () => {
    const { also: _second, ...one } = TWO
    let now: Asker = one
    const gate = new AskedGate({
      askedBy: () => now,
      ask: async () => ((now = TWO), 'allow'),
      cover: async (_id, r) => r(),
      noLooser: () => true,
      done: () => {},
    })
    expect(await gate.when('orc', { name: 'delete_session', args: { sessionId: 's' } }, undefined, run, refused)).toMatchObject({ isError: true })
  })
})
