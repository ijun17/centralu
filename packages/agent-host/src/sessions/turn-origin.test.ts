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
    await w.mgr.inputs.send(id, 'the task', undefined, FROM)
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
    await w.mgr.inputs.send(id, 'first', undefined, FROM)
    const first = handleOf(id).ids.at(-1)
    handleOf(id).answer('done')
    await w.mgr.inputs.send(id, 'second', undefined, FROM)
    // The session is working again from `second`; the tool now opens the turn it runs for `first`'s note
    opens(id, [first!])
    expect(opened()).toMatchObject({ origin: { seq: rowOf(id, 'first'), from: FROM } })
  })

  it("says nothing for another session's message on this computer: only a hub reads what a turn ran for", async () => {
    const id = await w.callerSession()
    await w.mgr.inputs.send(id, 'a note from a local session', undefined, { sessionId: 'a-local-session', name: 'Local' })
    // The message goes in named as any other (#1639), and the turn the tool opens for it names no sender
    expect(handleOf(id).ids.at(-1)).toEqual(expect.any(String))
    opens(id, [handleOf(id).ids.at(-1)!])
    expect(opened()).not.toHaveProperty('origin')
  })

  it('says nothing for a person’s message, or an input no sender gave', async () => {
    const id = await w.callerSession()
    // A control: the hub's message is named
    await w.mgr.inputs.send(id, 'the task', undefined, FROM)
    opens(id, [handleOf(id).ids.at(-1)!])
    expect(opened()).toHaveProperty('origin')
    handleOf(id).answer('done')
    await w.mgr.inputs.send(id, 'typed by the person')
    // Named too (#1639), but no sender is kept for it: the turn it opens has no origin
    opens(id, [handleOf(id).ids.at(-1)!])
    expect(opened()).not.toHaveProperty('origin')
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
    await w.mgr.inputs.send(id, 'the task', undefined, FROM)
    // The note goes into the running turn: its row comes before that turn's words
    await w.mgr.inputs.send(id, 'a note', undefined, FROM)
    handleOf(id).answer('first answer')
    // The tool runs the note as a turn of its own
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    handleOf(id).answer('second answer')
    const reader = w.mgr.linkedHost.hostReader()
    expect(await reader.lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
    // The last response of the record joins the two, as the report of that turn read it
    expect((await reader.lastAnswer(id)).text).toBe('first answer\n\nsecond answer')
  })

  it("is the turn before's when the next has said nothing yet, as the end that is being read was that turn's", async () => {
    const id = await w.callerSession()
    await w.mgr.inputs.send(id, 'the task', undefined, FROM)
    await w.mgr.inputs.send(id, 'a note', undefined, FROM)
    handleOf(id).answer('first answer')
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    handleOf(id).answer('second answer')
    // The next turn has begun as the hub reads the end of this one: the words are the second turn's, not the first's joined to them
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    expect(await w.mgr.linkedHost.hostReader().lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
  })

  /** A hub's session after a swap: a new owner of the turns over the store the old one wrote */
  const swap = () => {
    ;(w.mgr as unknown as { children: ChildOwnership }).children = new ChildOwnership(w.store)
  }
  const note = async (id: string) => {
    await w.mgr.inputs.send(id, 'the task', undefined, FROM)
    await w.mgr.inputs.send(id, 'a note', undefined, FROM)
    handleOf(id).answer('first answer')
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
  }

  it("is still the turn's own after a swap between the turn's start and the report: where it began is in the store", async () => {
    const id = await w.callerSession()
    await note(id)
    handleOf(id).answer('second answer')
    swap()
    const reader = w.mgr.linkedHost.hostReader()
    expect(await reader.lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
  })

  it('is empty for a turn that ended with nothing to say: never the turn before it', async () => {
    const id = await w.callerSession()
    await note(id)
    // The note's turn ends on a tool call, with no text
    handleOf(id).event({ type: 'turn_complete', sessionId: id })
    const reader = w.mgr.linkedHost.hostReader()
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
    expect(await w.mgr.linkedHost.hostReader().lastAnswer(id, undefined, true)).toMatchObject({ text: 'second answer' })
  })
})

/** What the host keeps of the turns of a session a hub gives messages: where they began, and nothing of whose they are (#1948 step 3) */
describe('what is kept of the turns a hub follows', () => {
  let w: CrossWorld
  const FROM = { sessionId: '_hub-orchestrator', name: 'Parent' }
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(() => w.dispose())
  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const spans = (id: string) => w.store.settings.appSetting(`turn_span:${id}`)
  /** A hub's task, then a note into the running turn: the note is given after the turn began */
  async function withNote() {
    const id = await w.callerSession()
    await w.mgr.inputs.send(id, 'the task', undefined, FROM)
    await w.mgr.inputs.send(id, 'a note', undefined, FROM)
    return id
  }

  it('says whose a note is when an error ends the turn but the process lives: the CLI can still run the note it holds as the next turn', async () => {
    const id = await withNote()
    handleOf(id).turnInputs = () => []
    handleOf(id).event({ type: 'error', sessionId: id, error: { code: 'internal', message: 'not logged in', retryable: true } })
    // The note runs as the next turn, and that turn says whose it is
    const noteId = handleOf(id).ids.at(-1)
    handleOf(id).turnStartInputs = () => [noteId!]
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    expect(w.events.filter((e) => e.type === 'state_change' && e.state === 'working').at(-1)).toHaveProperty('origin')
  })

  it('ends the turn it was in when a host starts with no process for a session its last left mid-turn: its words are its own, not the turn before it', async () => {
    const id = await withNote()
    handleOf(id).answer('first answer')
    // The note runs as a turn of its own, says something, and the host stops before the turn ends
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    handleOf(id).event({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'half of the second' })
    const before = w.mgr.linkedHost.hostReader()
    // A control: while the turn is running, what a hub reads is the turn before it
    expect(await before.lastAnswer(id, undefined, true)).toMatchObject({ text: 'first answer' })
    const restarted = new SessionManager(w.store, w.adapters, () => {}, undefined, `${w.caller.path}-worktrees`)
    try {
      expect(JSON.parse(spans(id)!).latest.ended).toBe(true)
      expect(await restarted.linkedHost.hostReader().lastAnswer(id, undefined, true)).toMatchObject({ text: 'half of the second' })
    } finally {
      await restarted.tenure.disposeAll()
    }
  })

  it('keeps nothing of the session once it is deleted, but its words', async () => {
    const id = await withNote()
    handleOf(id).answer('done')
    expect(spans(id)).not.toBeNull()
    await w.mgr.trash.trashSession(id)
    expect(spans(id)).toBeNull()
  })

  // docs/plans/turn-starter.md "After #1948 step 3": an earlier build reads these after a rollback, so this build never leaves a value there
  it('writes nothing of what an earlier build kept of whose a turn is, through turns, a stop, a crash and a new process', async () => {
    const id = await withNote()
    const kept = () => ['turn_inputs', 'report_turn', 'input_origins'].map((name) => w.store.settings.appSetting(`${name}:${id}`)).filter((v) => v !== null)
    handleOf(id).turnInputs = () => []
    handleOf(id).answer('done')
    handleOf(id).turnStartInputs = () => [handleOf(id).ids.at(-1)!]
    handleOf(id).event({ type: 'state_change', sessionId: id, state: 'working' })
    await w.mgr.inputs.send(id, 'typed by the person')
    w.mgr.inputs.interrupt(id)
    await w.mgr.inputs.send(id, 'again', undefined, FROM)
    // The conversation the tool keeps, which a new process resumes
    handleOf(id).externalId = 'conversation-1'
    handleOf(id).event({ type: 'error', sessionId: id, error: { code: 'adapter_crashed', message: 'gone', retryable: false } })
    await w.mgr.inputs.send(id, 'after the crash', undefined, FROM)
    // Nothing while a turn runs, nor after it
    expect(kept()).toEqual([])
    handleOf(id).answer('done')
    expect(kept()).toEqual([])
  })
})

/*
 * #2133 step 3 (docs/plans/assistant-rename.md): a machine of a later release records the hub's sender under the
 * Assistant's new name, and this build reads it as the hub's in each place it reads the sender
 */
describe("the hub's sender under the Assistant's new name (#2133)", () => {
  let w: CrossWorld
  const RENAMED = { sessionId: '_hub-assistant', name: 'Parent' }
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(() => w.dispose())
  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const rowOf = (id: string, text: string) => w.store.messages.loadMessages(id, 50).find((m) => m.role === 'user' && (m.payload as { text?: string }).text === text)!.seq
  function opens(id: string, inputs: readonly string[]) {
    const h = handleOf(id)
    h.turnStartInputs = () => inputs
    h.event({ type: 'state_change', sessionId: id, state: 'working' })
    h.turnStartInputs = () => null
  }
  const opened = () => w.events.filter((e) => e.type === 'state_change' && e.state === 'working').at(-1)

  it('reaches a session that directs others as the hub’s own words, not as an untrusted source', async () => {
    // The Assistant directs every other session
    const id = (await w.mgr.assistant()).id
    expect(w.mgr.tools.directs(id)).toBe(true)
    await w.mgr.inputs.send(id, 'an instruction', undefined, RENAMED)
    expect(handleOf(id).sent.at(-1)).toBe('an instruction')
    // A control: another sender's words to the same session are framed as an untrusted source
    handleOf(id).answer('done')
    await w.mgr.inputs.send(id, 'from elsewhere', undefined, { sessionId: 'a-local-session', name: 'Local' })
    expect(handleOf(id).sent.at(-1)).not.toBe('from elsewhere')
  })

  it('names the turn the tool opens for its message as the hub’s', async () => {
    const id = await w.callerSession()
    await w.mgr.inputs.send(id, 'the task', undefined, RENAMED)
    opens(id, [handleOf(id).ids.at(-1)!])
    expect(opened()).toMatchObject({ origin: { seq: rowOf(id, 'the task'), from: RENAMED } })
  })

  it('names it from the stored row after a swap, when nothing in memory says so', async () => {
    const id = await w.callerSession()
    await w.mgr.inputs.send(id, 'the task', undefined, RENAMED)
    const inputId = handleOf(id).ids.at(-1)!
    // A new owner of the turns over the store the old one wrote
    ;(w.mgr as unknown as { children: ChildOwnership }).children = new ChildOwnership(w.store)
    opens(id, [inputId])
    expect(opened()).toMatchObject({ origin: { seq: rowOf(id, 'the task'), from: RENAMED } })
  })
})
