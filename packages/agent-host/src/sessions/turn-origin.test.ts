import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { ChildOwnership } from './child-ownership.js'
import { SessionManager } from './manager.js'

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
    // The tool says which inputs a turn took in, as Claude does: none of them here
    handleOf(id).turnInputs = () => []
    await w.mgr.send(id, 'first', undefined, FROM)
    const first = handleOf(id).ids.at(-1)
    handleOf(id).answer('done')
    await w.mgr.send(id, 'second', undefined, FROM)
    // The session is working again from `second`; the tool now opens the turn it runs for `first`'s note
    opens(id, [first!])
    expect(opened()).toMatchObject({ origin: { seq: rowOf(id, 'first'), from: FROM } })
  })

  it("keeps nothing of another session's messages on this computer: only a hub reads what a turn ran for", async () => {
    const id = await w.callerSession()
    // A control: a hub's message is kept
    await w.mgr.send(id, 'a note from the hub', undefined, FROM)
    expect(w.store.settings.appSetting(`input_origins:${id}`)).not.toBeNull()
    const other = await w.callerSession()
    await w.mgr.send(other, 'a note from a local session', undefined, { sessionId: 'a-local-session', name: 'Local' })
    // The message goes in as any other at rest, and nothing is kept for a turn to name
    expect(handleOf(other).ids.at(-1)).toBeUndefined()
    expect(w.store.settings.appSetting(`input_origins:${other}`)).toBeNull()
  })

  it('says nothing for a person’s message, or an input no sender gave', async () => {
    const id = await w.callerSession()
    // A control: the hub's message is named
    await w.mgr.send(id, 'the task', undefined, FROM)
    opens(id, [handleOf(id).ids.at(-1)!])
    expect(opened()).toHaveProperty('origin')
    handleOf(id).answer('done')
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
    await w.mgr.send(id, 'a note', undefined, FROM)
    handleOf(id).answer('first answer')
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    handleOf(id).answer('second answer')
    // The next turn has begun as the hub reads the end of this one: the words are the second turn's, not the first's joined to them
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    expect(await w.mgr.hostReader().lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
  })

  /** A hub's session after a swap: a new owner of the turns over the store the old one wrote */
  const swap = () => {
    ;(w.mgr as unknown as { children: ChildOwnership }).children = new ChildOwnership(w.store)
  }
  const note = async (id: string) => {
    await w.mgr.send(id, 'the task', undefined, FROM)
    await w.mgr.send(id, 'a note', undefined, FROM)
    handleOf(id).answer('first answer')
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
  }

  it("is still the turn's own after a swap between the turn's start and the report: where it began is in the store", async () => {
    const id = await w.callerSession()
    await note(id)
    handleOf(id).answer('second answer')
    swap()
    const reader = w.mgr.hostReader()
    expect(await reader.lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
  })

  it('is empty for a turn that ended with nothing to say: never the turn before it', async () => {
    const id = await w.callerSession()
    await note(id)
    // The note's turn ends on a tool call, with no text
    handleOf(id).event({ type: 'turn_complete', sessionId: id })
    const reader = w.mgr.hostReader()
    // A control: the same turn, once it has said something, is its words
    expect(await reader.lastAnswer(id)).toMatchObject({ text: 'first answer' })
    expect(await reader.lastAnswer(id, undefined, true)).toMatchObject({ text: '', seq: null })
  })

  it('reads the turn before the running one while the next has begun, even after a swap', async () => {
    const id = await w.callerSession()
    await note(id)
    handleOf(id).answer('second answer')
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    swap()
    expect(await w.mgr.hostReader().lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
  })
})

/** What the host keeps of the messages a hub gave a session, for the turns it will run: it keeps none of it once nothing can run them */
describe('what is kept for the turns a hub may be owed', () => {
  let w: CrossWorld
  const FROM = { sessionId: '_hub-orchestrator', name: 'Parent' }
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(() => w.dispose())
  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const origins = (id: string) => w.store.settings.appSetting(`input_origins:${id}`)
  const spans = (id: string) => w.store.settings.appSetting(`turn_span:${id}`)
  /** A hub's task, then a note into the running turn: the note is given after the turn began */
  async function withNote() {
    const id = await w.callerSession()
    await w.mgr.send(id, 'the task', undefined, FROM)
    await w.mgr.send(id, 'a note', undefined, FROM)
    return id
  }

  it('keeps a note given during a turn that ended without saying it took it in (a control for the cases below)', async () => {
    const id = await withNote()
    handleOf(id).answer('done')
    expect(JSON.parse(origins(id)!)).toHaveLength(1)
  })

  it('keeps nothing of the notes given before a turn began once it ended, for a tool that does not name its inputs', async () => {
    const id = await withNote()
    handleOf(id).answer('done')
    // The tool ran the note as the next turn, not naming it (an older Claude Code): the turn after it ends, and it is done with
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    handleOf(id).answer('and the note')
    expect(JSON.parse(origins(id)!)).toEqual([])
  })

  it('keeps a note when an error ends the turn but the process lives: the CLI can still run the note it holds as the next turn', async () => {
    const id = await withNote()
    handleOf(id).turnInputs = () => []
    handleOf(id).event({ type: 'error', sessionId: id, error: { code: 'internal', message: 'not logged in', retryable: true } })
    // The task and the note are both held: the turn that ended took in neither
    expect(JSON.parse(origins(id)!)).toHaveLength(2)
    // The note runs as the next turn, and that turn says whose it is
    const noteId = handleOf(id).ids.at(-1)
    handleOf(id).turnStartInputs = () => [noteId!]
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    expect(w.events.filter((e) => e.type === 'state_change' && e.state === 'working').at(-1)).toHaveProperty('origin')
  })

  it('keeps a note when a usage limit ends the turn, the same', async () => {
    const id = await withNote()
    handleOf(id).turnInputs = () => []
    handleOf(id).event({ type: 'limit_reached', sessionId: id, usedPercent: 100 })
    expect(JSON.parse(origins(id)!)).toHaveLength(2)
  })

  it('keeps nothing when the process went with the turn: a crash, a lost conversation', async () => {
    for (const code of ['adapter_crashed', 'conversation_locked'] as const) {
      const id = await withNote()
      // A control: something is kept until then
      expect(origins(id)).not.toBeNull()
      handleOf(id).event({ type: 'error', sessionId: id, error: { code, message: 'gone', retryable: false } })
      expect(origins(id)).toBeNull()
    }
  })

  it('ends the turn it was in when a host starts with no process for a session its last left mid-turn: its words are its own, not the turn before it', async () => {
    const id = await withNote()
    handleOf(id).answer('first answer')
    // The note runs as a turn of its own, says something, and the host stops before the turn ends
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    handleOf(id).event({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'half of the second' })
    const before = w.mgr.hostReader()
    // A control: while the turn is running, what a hub reads is the turn before it
    expect(await before.lastAnswer(id, undefined, true)).toMatchObject({ text: 'first answer' })
    const restarted = new SessionManager(w.store, w.adapters, () => {}, undefined, `${w.caller.path}-worktrees`)
    try {
      expect(origins(id)).toBeNull()
      expect(JSON.parse(spans(id)!).latest.ended).toBe(true)
      expect(await restarted.hostReader().lastAnswer(id, undefined, true)).toMatchObject({ text: 'half of the second' })
    } finally {
      await restarted.disposeAll()
    }
  })

  it('keeps nothing when the session is stopped', async () => {
    const id = await withNote()
    // A control: something is kept until then
    expect(origins(id)).not.toBeNull()
    w.mgr.interrupt(id)
    expect(origins(id)).toBeNull()
  })

  it('keeps nothing for a new process: the one before it held the inputs', async () => {
    const id = await withNote()
    handleOf(id).turnInputs = () => []
    // The conversation the tool keeps, which a new process resumes
    handleOf(id).externalId = 'conversation-1'
    handleOf(id).answer('done')
    expect(origins(id)).not.toBeNull()
    // A tool whose sessions can sleep
    Object.assign(w.adapters.get('claude')!.capabilities, { backgroundTasks: true, sleep: true })
    expect(await w.mgr.sleepSession(id)).toBe(true)
    await w.mgr.send(id, 'typed by the person')
    expect(origins(id)).toBeNull()
  })

  it('keeps nothing of the session once it is deleted, but its words', async () => {
    const id = await withNote()
    handleOf(id).answer('done')
    expect(spans(id)).not.toBeNull()
    await w.mgr.trashSession(id)
    expect(origins(id)).toBeNull()
    expect(spans(id)).toBeNull()
  })
})
