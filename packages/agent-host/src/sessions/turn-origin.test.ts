import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * What a turn that opens says it ran for, and where its words begin (#1604), on the host a hub follows: the events a hub
 * reads, and what `host.lastAnswer` answers for a turn.
 */
describe('a turn the tool opens for an earlier message', () => {
  let w: CrossWorld
  const FROM = { sessionId: '_hub-orchestrator', name: 'Parent' }
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(() => w.dispose())

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const rowOf = (id: string, text: string) => w.store.messages.loadMessages(id, 50).find((m) => m.role === 'user' && (m.payload as { text?: string }).text === text)!.seq
  /** The tool opens a turn for the inputs it names: a `working` the host reads them with */
  function opens(id: string, inputs: readonly string[] | null) {
    const h = handleOf(id)
    h.turnStartInputs = () => inputs
    h.event({ type: 'state_change', sessionId: id, state: 'working' })
    h.turnStartInputs = () => null
  }
  const opened = () => w.events.filter((e) => e.type === 'state_change' && e.state === 'working').at(-1)

  it("names a sender's message given at rest an input id, and says whose it is when the tool opens a turn for it", async () => {
    const id = await w.callerSession()
    await w.mgr.send(id, 'the task', undefined, FROM)
    const inputId = handleOf(id).ids.at(-1)
    expect(inputId).toEqual(expect.any(String))
    // Sent at rest, the session is working already; the tool opens the turn of an earlier message after it
    opens(id, [inputId!])
    expect(opened()).toMatchObject({ origin: { seq: rowOf(id, 'the task'), from: FROM } })
  })

  it("says it for a turn that opens while the host already has the session working, not only as it leaves rest", async () => {
    const id = await w.callerSession()
    await w.mgr.send(id, 'first', undefined, FROM)
    const first = handleOf(id).ids.at(-1)
    handleOf(id).answer('done')
    await w.mgr.send(id, 'second', undefined, FROM)
    // The session is working again from `second`; the tool now opens the turn it runs for `first`'s note
    opens(id, [first!])
    expect(opened()).toMatchObject({ origin: { seq: rowOf(id, 'first'), from: FROM } })
  })

  it('says nothing for a person’s message, or an input no sender gave', async () => {
    const id = await w.callerSession()
    await w.mgr.send(id, 'typed by the person')
    expect(handleOf(id).ids.at(-1)).toBeUndefined()
    opens(id, ['an-input-nobody-named'])
    expect(opened()).not.toHaveProperty('origin')
  })
})

describe('the answer of the turn a hub asks about', () => {
  let w: CrossWorld
  const FROM = { sessionId: '_hub-orchestrator', name: 'Parent' }
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(() => w.dispose())
  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!

  it("is the turn run for a note alone, though the note's row was stored in the turn before it", async () => {
    const id = await w.callerSession()
    await w.mgr.send(id, 'the task', undefined, FROM)
    // The note goes into the running turn: its row comes before that turn's words
    await w.mgr.send(id, 'a note', undefined, FROM)
    handleOf(id).answer('first answer')
    // The tool runs the note as a turn of its own
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    handleOf(id).answer('second answer')
    const reader = w.mgr.hostReader()
    expect(await reader.lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
    // The last response of the record joins the two, as the report of that turn read it
    expect((await reader.lastAnswer(id)).text).toBe('first answer\n\nsecond answer')
  })

  it("is the turn before's when the next has said nothing yet, as the end that is being read was that turn's", async () => {
    const id = await w.callerSession()
    await w.mgr.send(id, 'the task', undefined, FROM)
    handleOf(id).answer('the answer')
    // The next turn has begun as the hub reads the end of this one
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    expect(await w.mgr.hostReader().lastAnswer(id, undefined, true)).toMatchObject({ text: 'the answer' })
  })
})
