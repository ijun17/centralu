import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAdapter } from '../adapters/contract.js'
import type { ApprovalDetail, PermissionPreset, Question, QuestionAnswer, ToolName } from '@cc/protocol'
import { CrossAdapter, crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'
import { answersFrom, decisionFrom } from './delegated-cards.js'
import { SessionManager } from './manager.js'
import { runOrchestratorTool } from './orchestrator-tools.js'

/**
 * Cards in a delegated turn (#676): when a session works on a turn another session gave it (start_agent,
 * agent_session send, ask_project, send_to_session), the cards it raises in that turn go to the session that asked
 * as well as to the person. A question it may answer, first answer wins; an approval it is only told of, unless its
 * own preset is auto when it answers. It is told with a notice that never carries the card's text, and reads the
 * card through a tool. The link ends with the turn and survives a host swap.
 */

const QUESTION: Question = {
  question: 'Which database should the schema target?',
  header: 'Database',
  options: [{ label: 'Postgres', description: 'the server' }, { label: 'SQLite', description: 'the file' }],
  multiSelect: false,
}
const COMMAND: ApprovalDetail = { kind: 'command', command: 'rm -rf build', cwd: '/tmp' }

/** The fake handle answers cards as a CLI does: the first answer lands and closes the card, a later one does not */
function answering(h: CrossHandle) {
  const answered: { requestId: string; answers?: QuestionAnswer[]; decision?: string }[] = []
  const open = new Set<string>()
  const self = h as unknown as {
    answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean
    respondApproval(requestId: string, decision: string): boolean
  }
  self.answerQuestion = (requestId, answers) => {
    if (!open.delete(requestId)) return false
    answered.push({ requestId, answers })
    h.event({ type: 'question_resolved', sessionId: h.sessionId, requestId })
    return true
  }
  self.respondApproval = (requestId, decision) => {
    if (!open.delete(requestId)) return false
    answered.push({ requestId, decision })
    h.event({ type: 'approval_resolved', sessionId: h.sessionId, requestId, decision: decision as 'allow' })
    return true
  }
  return {
    answered,
    ask(requestId: string, questions: Question[] = [QUESTION]) {
      open.add(requestId)
      h.event({ type: 'question_request', sessionId: h.sessionId, requestId, questions })
    },
    approval(requestId: string, detail: ApprovalDetail = COMMAND) {
      open.add(requestId)
      h.event({ type: 'approval_request', sessionId: h.sessionId, requestId, detail })
    },
  }
}

describe('reading the caller\'s answer', () => {
  it('takes one question\'s whole text, matches an option\'s label case aside, and keeps free text', () => {
    expect(answersFrom([QUESTION], 'sqlite')).toEqual([{ question: QUESTION.question, answers: ['SQLite'] }])
    expect(answersFrom([QUESTION], 'neither: use DuckDB')).toEqual([{ question: QUESTION.question, answers: ['neither: use DuckDB'] }])
  })
  it('takes one line per question, ";" between a multi-select\'s choices, or a JSON array', () => {
    const multi: Question = { ...QUESTION, question: 'Which targets?', multiSelect: true }
    expect(answersFrom([QUESTION, multi], 'Postgres\npostgres; sqlite')).toEqual([
      { question: QUESTION.question, answers: ['Postgres'] },
      { question: 'Which targets?', answers: ['Postgres', 'SQLite'] },
    ])
    expect(answersFrom([QUESTION, multi], '["SQLite", ["Postgres"]]')).toEqual([
      { question: QUESTION.question, answers: ['SQLite'] },
      { question: 'Which targets?', answers: ['Postgres'] },
    ])
    expect(answersFrom([QUESTION, multi], 'Postgres')).toMatchObject({ error: expect.stringContaining('give 2 answers') })
    expect(answersFrom([QUESTION], '["Postgres", "SQLite"]')).toMatchObject({ error: expect.stringContaining('give 1 answers') })
  })
  it('reads an approval as allow or deny, never always', () => {
    expect(decisionFrom(' Allow ')).toBe('allow')
    expect(decisionFrom('no')).toBe('deny')
    expect(decisionFrom('always')).toBeNull()
  })
})

describe('cards in a delegated turn (#676)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  /** A parent with a child it started without waiting; the child is in the turn the parent gave it */
  const parentAndChild = async (preset: PermissionPreset = 'normal') => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const parent = await session(preset)
    const r = await w.mgr.startAgent(parent, { task: 'write the schema', wait: false })
    if (!r.ok) throw new Error(r.error)
    return { parent, child: r.sessionId, cards: answering(handleOf(r.sessionId)) }
  }
  /** Notices in the parent's conversation that name the child as their source */
  const notices = (parent: string, child: string) =>
    w.store.messages.loadMessages(parent, 50).filter((m) => m.role === 'user' && (m.payload as { from?: { sessionId: string } }).from?.sessionId === child)
  const toAgent = (parent: string, child: string) => handleOf(parent).sent.filter((t) => t.includes(child))
  /** The handle the caller reads a card by (agent_session status), which its answer names */
  const handleIn = async (caller: string, session: string, requestId: string) => {
    const r = await w.mgr.agentSession(caller, { sessionId: session, action: 'status' })
    const card = r.ok && r.state === 'asking' ? r.cards.find((c) => c.requestId === requestId)?.card : undefined
    if (!card) throw new Error(`no card ${requestId}`)
    return card
  }

  it('tells the parent of a question in the turn it gave, and the parent answers it', async () => {
    const { parent, child, cards } = await parentAndChild()
    cards.ask('q-1')
    await w.until(() => notices(parent, child).length === 1)
    // The notice is the host's words: never the question's text, in the conversation or in what the agent reads
    const notice = notices(parent, child)[0]!
    expect(JSON.stringify(notice.payload)).not.toContain(QUESTION.question)
    expect(JSON.stringify(notice.payload)).toContain('asking a question')
    expect(toAgent(parent, child)).toHaveLength(1)
    expect(toAgent(parent, child)[0]).not.toContain(QUESTION.question)
    expect(toAgent(parent, child)[0]).toContain('action="answer"')

    // The question arrives as a tool result
    const status = await w.mgr.agentSession(parent, { sessionId: child, action: 'status' })
    expect(status).toMatchObject({ ok: true, state: 'asking', cards: [{ requestId: 'q-1', card: expect.stringMatching(/^q-1\./), kind: 'question', questions: [QUESTION] }] })
    const shown = await runOrchestratorTool({ agentSession: async () => status } as never, 'agent_session', { sessionId: child, action: 'status' }, { sessionId: parent, profile: 'reader' })
    expect(shown.text).toContain('Which database')
    expect(shown.text).toContain('as JSON')

    const q1 = await handleIn(parent, child, 'q-1')
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: q1, text: 'sqlite' })).toMatchObject({ ok: true, state: 'answered', card: q1 })
    expect(cards.answered).toEqual([{ requestId: 'q-1', answers: [{ question: QUESTION.question, answers: ['SQLite'] }] }])
    expect(w.mgr.listSessions().find((s) => s.id === child)!.pendingQuestions).toEqual([])
  })

  it('lets the person answer first; the parent\'s later answer does not land', async () => {
    const { parent, child, cards } = await parentAndChild()
    cards.ask('q-1')
    await w.until(() => notices(parent, child).length === 1)
    const shown = await handleIn(parent, child, 'q-1')
    w.mgr.answerQuestion(child, 'q-1', [{ question: QUESTION.question, answers: ['Postgres'] }])
    const late = await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: shown, text: 'SQLite' })
    expect(late).toMatchObject({ ok: false, error: expect.stringContaining('no longer stands') })
    expect(cards.answered).toEqual([{ requestId: 'q-1', answers: [{ question: QUESTION.question, answers: ['Postgres'] }] }])
  })

  it('returns the question from a parent\'s wait instead of a notice', async () => {
    const { parent, child, cards } = await parentAndChild()
    const waiting = w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
    await new Promise((r) => setTimeout(r, 20))
    cards.ask('q-1')
    expect(await waiting).toMatchObject({ ok: true, state: 'asking', cards: [{ requestId: 'q-1' }] })
    await new Promise((r) => setTimeout(r, 20))
    expect(notices(parent, child)).toEqual([])
    // Answered, the turn goes on and the parent is still told when it ends
    await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: await handleIn(parent, child, 'q-1'), text: 'Postgres' })
    handleOf(child).answer('schema written')
    await w.until(() => notices(parent, child).some((m) => JSON.stringify(m.payload).includes('The assigned work finished')))
  })

  it('tells the parent of an approval but refuses its answer unless the parent is auto when it answers', async () => {
    const { parent, child, cards } = await parentAndChild()
    cards.approval('a-1')
    await w.until(() => notices(parent, child).length === 1)
    expect(JSON.stringify(notices(parent, child)[0]!.payload)).toContain('Only the person can answer it')
    expect(JSON.stringify(notices(parent, child)[0]!.payload)).not.toContain('rm -rf')
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'status' })).toMatchObject({
      state: 'asking', cards: [{ requestId: 'a-1', kind: 'approval', answerable: false }],
    })
    const a1 = await handleIn(parent, child, 'a-1')
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: a1, text: 'allow' })).toMatchObject({ ok: false, error: expect.stringContaining('Only the person') })
    expect(cards.answered).toEqual([])

    // The parent's preset at the call decides
    await w.mgr.updateSettings(parent, { permissionPreset: 'auto' })
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: a1, text: 'deny' })).toMatchObject({ ok: true, state: 'answered' })
    expect(cards.answered).toEqual([{ requestId: 'a-1', decision: 'deny' }])
  })

  it('does not route a card from a later turn the person started', async () => {
    const { parent, child, cards } = await parentAndChild()
    handleOf(child).answer('schema written')
    await w.until(() => notices(parent, child).length === 1)
    await w.mgr.send(child, 'now also add an index')
    cards.ask('q-person')
    await new Promise((r) => setTimeout(r, 30))
    expect(notices(parent, child)).toHaveLength(1)
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'status' })).not.toMatchObject({ state: 'asking' })
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', text: 'x' })).toMatchObject({ ok: false })
    expect(cards.answered).toEqual([])
  })

  it('routes an ask_project target\'s question to the asking project, which answers it across projects', async () => {
    const caller = await w.callerSession()
    const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const cards = answering(handleOf(target))
    const asking = w.mgr.askProject(caller, { project: w.target.name, session: target, task: 'migrate it' })
    await w.until(() => handleOf(target).sent.length === 1)
    cards.ask('q-x')
    expect(await asking).toMatchObject({ ok: true, state: 'asking', sessionId: target, cards: [{ requestId: 'q-x' }] })
    // Only the cards: the rest of another project's session stays the person's
    expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'stop' })).toMatchObject({ ok: false })
    expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'answer', card: await handleIn(caller, target, 'q-x'), text: 'Postgres' })).toMatchObject({ ok: true, state: 'answered' })
    expect(cards.answered).toHaveLength(1)
    handleOf(target).answer('migrated')
    expect(await w.mgr.askProject(caller, { project: w.target.name, session: target })).toMatchObject({ ok: true, state: 'done', answer: 'migrated' })
    // The link ended with the turn
    expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'status' })).toMatchObject({ ok: false })
  })

  it('routes a send_to_session turn\'s card to the orchestrator, which reads it with read_session and answers it', async () => {
    const orch = await w.mgr.orchestrator()
    const worker = await session()
    const cards = answering(handleOf(worker))
    const tools = (w.mgr as unknown as { orchestratorToolsFor(id: string): import('../adapters/contract.js').OrchestratorTools }).orchestratorToolsFor(orch.id)
    expect(await tools.sendToSession(worker, 'build it', false)).toEqual({ ok: true })
    cards.ask('q-o')
    await w.until(() => notices(orch.id, worker).length === 1)
    const read = await runOrchestratorTool(tools, 'read_session', { sessionId: worker }, { sessionId: orch.id, profile: 'orchestrator' })
    expect(read.text).toContain('Which database')
    expect(read.text).toContain('answer_question')
    const read2 = await tools.readSession(worker)
    expect(await tools.answerQuestion({ sessionId: worker, card: read2.cards?.[0]?.card, text: 'Postgres' })).toMatchObject({ ok: true, state: 'answered' })
    expect(cards.answered).toHaveLength(1)
  })

  it('does not give the orchestrator a turn the session was already running', async () => {
    const orch = await w.mgr.orchestrator()
    const worker = await session()
    const cards = answering(handleOf(worker))
    await w.mgr.send(worker, 'the person\'s own work')
    const tools = (w.mgr as unknown as { orchestratorToolsFor(id: string): import('../adapters/contract.js').OrchestratorTools }).orchestratorToolsFor(orch.id)
    await tools.sendToSession(worker, 'also this', false)
    cards.ask('q-p')
    await new Promise((r) => setTimeout(r, 30))
    expect(notices(orch.id, worker)).toEqual([])
    expect(await tools.answerQuestion({ sessionId: worker, text: 'Postgres' })).toMatchObject({ ok: false })
  })
})

describe('what a delegated turn\'s caller may answer (#679 review)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const toldOf = (caller: string, session: string) =>
    w.store.messages.loadMessages(caller, 50).filter((m) => m.role === 'user' && (m.payload as { from?: { sessionId: string } }).from?.sessionId === session)
  const cardsOf = async (caller: string, session: string) => {
    const r = await w.mgr.agentSession(caller, { sessionId: session, action: 'status' })
    return r.ok && r.state === 'asking' ? r.cards : []
  }
  const orchestratorTools = (id: string) => (w.mgr as unknown as { orchestratorToolsFor(id: string): import('../adapters/contract.js').OrchestratorTools }).orchestratorToolsFor(id)

  describe('an auto caller never approves for a safe session, on every path', () => {
    it('ask_project', async () => {
      const caller = await w.callerSession()
      await w.mgr.updateSettings(caller, { permissionPreset: 'auto' })
      const run = async (preset: PermissionPreset) => {
        const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: preset })).id
        const cards = answering(handleOf(target))
        const asking = w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'clean the build' })
        await w.until(() => handleOf(target).sent.length === 1)
        cards.approval('a-1')
        const r = await asking
        const card = r.ok && r.state === 'asking' ? r.cards[0]! : undefined
        return { card, answer: await w.mgr.agentSession(caller, { sessionId: target, action: 'answer', card: card?.card, text: 'allow' }), cards }
      }
      const safe = await run('safe')
      expect(safe.card).toMatchObject({ kind: 'approval', answerable: false })
      expect(safe.answer).toMatchObject({ ok: false, error: expect.stringContaining('safe') })
      expect(safe.cards.answered).toEqual([])
      // A normal target takes the auto caller's answer: the rule is the target's preset, not the path
      const normal = await run('normal')
      expect(normal.answer).toMatchObject({ ok: true, state: 'answered' })
      expect(normal.cards.answered).toEqual([{ requestId: 'a-1', decision: 'allow' }])
    })

    it('send_to_session and answer_question', async () => {
      const orch = await w.mgr.orchestrator()
      await w.mgr.updateSettings(orch.id, { permissionPreset: 'auto' })
      const tools = orchestratorTools(orch.id)
      const run = async (preset: PermissionPreset) => {
        const worker = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
        const cards = answering(handleOf(worker))
        await tools.sendToSession(worker, 'clean the build', false)
        cards.approval('a-1')
        await w.until(() => toldOf(orch.id, worker).length === 1)
        const read = await tools.readSession(worker)
        return { told: JSON.stringify(toldOf(orch.id, worker)[0]!.payload), answer: await tools.answerQuestion({ sessionId: worker, card: read.cards?.[0]?.card, text: 'allow' }), cards }
      }
      const safe = await run('safe')
      expect(safe.told).toContain('Only the person can answer it')
      expect(safe.answer).toMatchObject({ ok: false, error: expect.stringContaining('safe') })
      expect(safe.cards.answered).toEqual([])
      const normal = await run('normal')
      expect(normal.told).toContain('Your permission preset is auto')
      expect(normal.answer).toMatchObject({ ok: true, state: 'answered' })
    })

    it('agent_session send to a child the person lowered to safe', async () => {
      w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      const parent = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'auto' })).id
      const started = await w.mgr.startAgent(parent, { task: 'first', wait: false })
      if (!started.ok) throw new Error(started.error)
      const child = started.sessionId
      // A conversation to resume once the preset change restarts it
      handleOf(child).externalId = 'ext-child'
      handleOf(child).answer('first done')
      await w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
      await w.mgr.updateSettings(child, { permissionPreset: 'safe' })
      const sending = w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'clean the build' })
      await w.until(() => (handleOf(child).sent.at(-1) ?? '').includes('clean the build'))
      const cards = answering(handleOf(child))
      cards.approval('a-1')
      const r = await sending
      expect(r).toMatchObject({ ok: true, state: 'asking', cards: [{ kind: 'approval', answerable: false }] })
      const card = r.ok && r.state === 'asking' ? r.cards[0]!.card : ''
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card, text: 'allow' })).toMatchObject({ ok: false, error: expect.stringContaining('safe') })
      expect(cards.answered).toEqual([])
    })
  })

  describe('a task that joins a turn the person is running gives its caller none of that turn\'s cards', () => {
    it('ask_project into the person\'s turn', async () => {
      const caller = await w.callerSession()
      // Joining a turn that is not its own is a note, the caller's choice under auto (#677)
      await w.mgr.updateSettings(caller, { permissionPreset: 'auto' })
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      const cards = answering(handleOf(target))
      await w.mgr.send(target, "the person's own work")
      let settled = false
      void w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'also this', ifBusy: 'note' }).then(() => { settled = true })
      await w.until(() => handleOf(target).sent.length === 2)
      cards.ask('q-person')
      cards.approval('a-person')
      await new Promise((r) => setTimeout(r, 30))
      // Not told, its wait not answered with the person's cards, and nothing to answer
      expect(toldOf(caller, target)).toEqual([])
      expect(settled).toBe(false)
      expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'status' })).toMatchObject({ ok: false })
      for (const card of ['q-person', 'a-person']) {
        expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'answer', card, text: 'allow' })).toMatchObject({ ok: false })
      }
      expect(cards.answered).toEqual([])
      expect(w.store.children.listDelegatedTurns()).toEqual([])
    })

    it('an auto parent\'s note into the turn the person started in its child', async () => {
      w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      const parent = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'auto' })).id
      const started = await w.mgr.startAgent(parent, { task: 'first', wait: false })
      if (!started.ok) throw new Error(started.error)
      const child = started.sessionId
      handleOf(child).answer('first done')
      await w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
      const before = toldOf(parent, child).length
      await w.mgr.send(child, "the person's own work")
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'a note' })).toMatchObject({ ok: true })
      const cards = answering(handleOf(child))
      cards.approval('a-person')
      await new Promise((r) => setTimeout(r, 30))
      expect(toldOf(parent, child)).toHaveLength(before)
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: 'a-person', text: 'allow' })).toMatchObject({ ok: false })
      expect(cards.answered).toEqual([])
    })
  })

  describe('an answer meets only the card its caller read', () => {
    const parentAndChild = async () => {
      w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      const parent = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
      const started = await w.mgr.startAgent(parent, { task: 'write the schema', wait: false })
      if (!started.ok) throw new Error(started.error)
      return { parent, child: started.sessionId }
    }
    const OTHER: Question = { question: 'Delete the old tables?', header: 'Cleanup', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }

    it('refuses an earlier card\'s handle once a new card reuses its request id (a restarted adapter numbers again)', async () => {
      const { parent, child } = await parentAndChild()
      const cards = answering(handleOf(child))
      cards.ask('req-1')
      await w.until(() => toldOf(parent, child).length === 1)
      const read = (await cardsOf(parent, child))[0]!.card
      w.mgr.answerQuestion(child, 'req-1', [{ question: QUESTION.question, answers: ['Postgres'] }])
      // A new process asks something else under the same id
      cards.ask('req-1', [OTHER])
      await w.until(() => toldOf(parent, child).length === 2)
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: read, text: 'SQLite' })).toMatchObject({ ok: false, error: expect.stringContaining('replaced') })
      expect(cards.answered).toEqual([{ requestId: 'req-1', answers: [{ question: QUESTION.question, answers: ['Postgres'] }] }])
      // The card it reads now is the new one
      const now = (await cardsOf(parent, child))[0]!
      expect(now.card).not.toBe(read)
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: now.card, text: 'No' })).toMatchObject({ ok: true, state: 'answered' })
    })

    it('refuses a handle from an earlier delegated turn, even for the same id and question', async () => {
      const { parent, child } = await parentAndChild()
      let cards = answering(handleOf(child))
      cards.ask('req-1')
      await w.until(() => toldOf(parent, child).length === 1)
      const read = (await cardsOf(parent, child))[0]!.card
      w.mgr.answerQuestion(child, 'req-1', [{ question: QUESTION.question, answers: ['Postgres'] }])
      handleOf(child).answer('schema written')
      await w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
      const next = w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'and the index' })
      await w.until(() => (handleOf(child).sent.at(-1) ?? '').includes('and the index'))
      cards = answering(handleOf(child))
      cards.ask('req-1')
      await next
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: read, text: 'SQLite' })).toMatchObject({ ok: false })
      expect(cards.answered).toEqual([])
    })

    it('needs the handle: an answer naming no card is refused, even with one card standing', async () => {
      const { parent, child } = await parentAndChild()
      answering(handleOf(child)).ask('req-1')
      await w.until(() => toldOf(parent, child).length === 1)
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', text: 'SQLite' })).toMatchObject({ ok: false, error: expect.stringContaining('Name the card') })
    })
  })
})

describe('a delegated turn\'s link across a host swap (#676)', () => {
  let w: CrossWorld
  const hosts: SessionManager[] = []
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.disposeAll()
    await w.dispose()
  })

  it('keeps routing the kept child\'s card to its parent under the next host, without telling it twice', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const parent = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    const r = await w.mgr.startAgent(parent, { task: 'write the schema', wait: false })
    if (!r.ok) throw new Error(r.error)
    const child = r.sessionId
    // The parent has a conversation to resume under the next host, so a second notice would reach it
    w.adapters.get('claude')!.handles.get(parent)!.externalId = 'ext-parent'
    answering(w.adapters.get('claude')!.handles.get(child)!).ask('q-1')
    const told = () => w.store.messages.loadMessages(parent, 50).filter((m) => (m.payload as { from?: { sessionId: string } }).from?.sessionId === child)
    await w.until(() => told().length === 1)
    await w.mgr.detachAll()
    expect(w.store.children.listDelegatedTurns()).toEqual([{ sessionId: child, callerSessionId: parent, told: [expect.stringMatching(/^q-1\./)], turnId: expect.any(String) }])

    const claude = new CrossAdapter('claude')
    const next = new SessionManager(w.store, new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', new CrossAdapter('codex')]]), () => {}, undefined, undefined, { keptSessions: new Set([child]) })
    hosts.push(next)
    await next.adoptKept([{ sessionId: child, tool: 'claude', process: {} as never }])
    // The kept CLI sends its standing card again to the new host
    const cards = answering(claude.handles.get(child)!)
    cards.ask('q-1')
    await new Promise((r) => setTimeout(r, 50))
    expect(told()).toHaveLength(1)
    // A new card in the same turn is told, through the parent's resumed conversation
    cards.ask('q-2')
    await w.until(() => told().length === 2)
    cards.answered.length = 0
    const standing = await next.agentSession(parent, { sessionId: child, action: 'status' })
    expect(standing).toMatchObject({ state: 'asking', cards: [{ requestId: 'q-1' }, { requestId: 'q-2' }] })
    expect(await next.agentSession(parent, { sessionId: child, action: 'answer', card: standing.ok && standing.state === 'asking' ? standing.cards[0]!.card : '', text: 'Postgres' })).toMatchObject({ ok: true, state: 'answered' })
    expect(cards.answered).toHaveLength(1)
    // The turn ends under the new host, and the link with it
    claude.handles.get(child)!.answer('done')
    await new Promise((r) => setTimeout(r, 20))
    expect(w.store.children.listDelegatedTurns()).toEqual([])
  })

  it('is dropped by a host that finds no process for the session', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const parent = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    const r = await w.mgr.startAgent(parent, { task: 'write the schema', wait: false })
    if (!r.ok) throw new Error(r.error)
    await w.mgr.detachAll()
    const next = new SessionManager(w.store, new Map<ToolName, AgentAdapter>([['claude', new CrossAdapter('claude')]]), () => {}, undefined, undefined, {})
    hosts.push(next)
    expect(w.store.children.listDelegatedTurns()).toEqual([])
  })
})
