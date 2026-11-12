import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAdapter } from '../adapters/contract.js'
import type { ApprovalDetail, PermissionPreset, Question, QuestionAnswer, ToolName } from '@cc/protocol'
import type { UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { CrossAdapter, crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'
import { answersFrom, decisionFrom } from './delegated-cards.js'
import { RoutedCards, type RoutedCardsHost } from './routed-cards.js'
import { SessionManager } from './manager.js'
import { runCentraluTool } from './centralu-tools.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { PERSON } from '../mail/address.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * Cards in work another session gave (#676, docs/plans/mailbox.md §10.6.4): when a session has work open from others (start_agent,
 * agent_session send, ask_project, send_to_session with reportBack), every one of them hears of a card it raises, once, by a Centralu
 * notice that never carries the card's text, and reads the card through a tool. One of them answers it only as the gate allows (the
 * one party whose the turn is alone; an approval only under auto, never for a safe session); the person answers it on the card, and
 * the first answer counts.
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


/**
 * The host's mail on the world's manager, its clock the test's: a card's notice is mail (docs/plans/mailbox.md §10.6.4), given when the test runs the
 * delivery for its receiver (`deliver`)
 */
function mailOn(w: CrossWorld) {
  const clock = { t: Date.now() }
  const m = wireHostMail(w.mgr, w.store, { now: () => clock.t })
  m.delivery.start()
  const read = mailReader(w.store)
  return {
    m,
    read,
    /** Centralu's notices of the cards of `session` to `giver`, oldest first */
    told: (giver: string, session: string) => read.to(addressOf(giver)).filter((x) => x.message.facts.card?.session === addressOf(session)),
    /** The mail due for `sessionId` now is given it (past the debounce), as the delivery would; its tool takes it at once, as Claude does */
    deliver: async (sessionId: string) => {
      w.adapters.get('claude')!.handles.get(sessionId)!.acceptsAtOnce = true
      clock.t += 3_000
      await m.delivery.process(addressOf(sessionId))
    },
  }
}

describe('cards in work another session gave (#676, docs/plans/mailbox.md §10.6.4)', () => {
  let w: CrossWorld
  let mail: ReturnType<typeof mailOn>
  beforeEach(async () => {
    w = await crossWorld()
    mail = mailOn(w)
  })
  afterEach(async () => {
    mail.m.delivery.stop()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  /** A parent with a child it started without waiting; the child is in the turn the parent's task opened */
  const parentAndChild = async (preset: PermissionPreset = 'normal') => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const parent = await session(preset)
    const r = await w.mgr.startAgent(parent, { task: 'write the schema', wait: false })
    if (!r.ok) throw new Error(r.error)
    return { parent, child: r.sessionId, cards: answering(handleOf(r.sessionId)) }
  }
  /** Rows in the giver's conversation that name the session as their source */
  const shownIn = (giver: string, session: string) =>
    w.store.messages.loadMessages(giver, 50).filter((m) => m.role === 'user' && (m.payload as { from?: { sessionId: string } }).from?.sessionId === session)
  /** The handle the caller reads a card by (agent_session status), which its answer names */
  const handleIn = async (caller: string, session: string, requestId: string) => {
    const r = await w.mgr.agentSession(caller, { sessionId: session, action: 'status' })
    const card = r?.ok && r.state === 'asking' ? r.cards.find((c) => c.requestId === requestId)?.card : undefined
    if (!card) throw new Error(`no card ${requestId}`)
    return card
  }

  it('tells the parent of a question by mail, shown as from the child as before, and the parent answers it', async () => {
    const { parent, child, cards } = await parentAndChild()
    cards.ask('q-1')
    const [notice] = mail.told(parent, child)
    // The notice is the host's words: never the question's text
    expect(notice!.message).toMatchObject({ sender: 'centralu', kind: 'notice', facts: { card: { requestId: 'q-1', kind: 'question', handle: expect.stringMatching(/^q-1\./) } } })
    expect(notice!.message.body).not.toContain(QUESTION.question)
    expect(notice!.message.body).toContain('asking a question')
    // Given, it wakes the parent with the frame, which the parent reads with `mail read` as any notice of Centralu's, and its conversation shows the
    // notice as from the child, as the relayed notice did
    await mail.deliver(parent)
    expect(shownIn(parent, child)).toHaveLength(1)
    expect(shownIn(parent, child)[0]!.payload).toMatchObject({ text: notice!.message.body, mail: true })
    const frame = handleOf(parent).sent.at(-1) ?? ''
    expect(frame).toContain(notice!.message.id)
    expect(frame).not.toContain(QUESTION.question)
    expect(notice!.message.body).toContain('action="answer"')

    // The question arrives as a tool result
    const status = await w.mgr.agentSession(parent, { sessionId: child, action: 'status' })
    expect(status).toMatchObject({ ok: true, state: 'asking', cards: [{ requestId: 'q-1', card: notice!.message.facts.card?.handle, kind: 'question', questions: [QUESTION], answerable: true }] })
    const shown = await runCentraluTool({ agentSession: async () => status } as never, 'agent_session', { sessionId: child, action: 'status' }, { sessionId: parent, profile: 'reader' })
    expect(shown.text).toContain('Which database')
    expect(shown.text).toContain('as JSON')

    const q1 = await handleIn(parent, child, 'q-1')
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: q1, text: 'sqlite' })).toMatchObject({ ok: true, state: 'answered', card: q1 })
    expect(cards.answered).toEqual([{ requestId: 'q-1', answers: [{ question: QUESTION.question, answers: ['SQLite'] }] }])
    expect(w.mgr.listSessions().find((s) => s.id === child)!.pendingQuestions).toEqual([])
  })

  it('lets the person answer first by the card itself; the parent\'s later answer does not land', async () => {
    const { parent, child, cards } = await parentAndChild()
    cards.ask('q-1')
    const shown = await handleIn(parent, child, 'q-1')
    // The person's card is the session's own, unchanged by the notice
    expect(w.mgr.sessionInfo(child)?.pendingQuestions).toEqual([expect.objectContaining({ requestId: 'q-1', questions: [QUESTION] })])
    w.mgr.inputs.answerQuestion(child, 'q-1', [{ question: QUESTION.question, answers: ['Postgres'] }])
    const late = await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: shown, text: 'SQLite' })
    expect(late).toMatchObject({ ok: false, error: expect.stringContaining('no longer stands') })
    expect(cards.answered).toEqual([{ requestId: 'q-1', answers: [{ question: QUESTION.question, answers: ['Postgres'] }] }])
  })

  it('returns the question from a parent\'s wait, and writes its notice as read', async () => {
    const { parent, child, cards } = await parentAndChild()
    const [task] = mail.read.tasks(addressOf(parent), child)
    const waiting = w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
    await new Promise((r) => setTimeout(r, 20))
    cards.ask('q-1')
    expect(await waiting).toMatchObject({ ok: true, state: 'asking', cards: [{ requestId: 'q-1' }] })
    // Told once, by the call itself: nothing waits to wake the parent
    expect(mail.told(parent, child)).toHaveLength(1)
    expect(mail.told(parent, child)[0]!.row).toMatchObject({ deliveredAt: expect.any(Number), readAt: expect.any(Number) })
    expect(mail.m.service.wakingFor(addressOf(parent))).toBe(false)
    // Answered, the turn goes on, and its last response still answers the parent's task when it ends
    await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: await handleIn(parent, child, 'q-1'), text: 'Postgres' })
    handleOf(child).answer('schema written')
    await w.until(() => mail.read.reportsOn(task!.id).length === 1)
    expect(mail.read.reportsOn(task!.id)[0]!.facts.answer).toBe('schema written')
  })

  it('tells the parent of an approval but refuses its answer unless the parent is auto when it answers', async () => {
    const { parent, child, cards } = await parentAndChild()
    cards.approval('a-1')
    const [notice] = mail.told(parent, child)
    expect(notice!.message.body).toContain('Only the person can answer it')
    expect(notice!.message.body).not.toContain('rm -rf')
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

  it('tells every sender with work open in the turn once, and none of them answers it there', async () => {
    // Two sessions of the caller's project ask one session of another, the second while the first's task runs: its task joins that turn
    const [a, b] = [await w.callerSession(), await w.callerSession()]
    for (const s of [a, b]) await w.mgr.updateSettings(s, { permissionPreset: 'auto' })
    const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const cards = answering(handleOf(target))
    const asking = w.mgr.askProject(a, { project: w.target.name, session: target, task: 'migrate it' })
    await w.until(() => handleOf(target).sent.length === 1)
    expect(await w.mgr.askProject(b, { project: w.target.name, session: target, task: 'and seed it' })).toMatchObject({ ok: true, state: 'mailed' })
    handleOf(target).acceptsAtOnce = true
    await mail.deliver(target)
    expect(handleOf(target).sent).toHaveLength(2)

    cards.approval('a-1')
    await asking
    // A kept CLI raises a standing card again under the next host: still once each
    handleOf(target).event({ type: 'approval_request', sessionId: target, requestId: 'a-1', detail: COMMAND })
    for (const giver of [a, b]) {
      expect(mail.told(giver, target)).toHaveLength(1)
      expect(await w.mgr.agentSession(giver, { sessionId: target, action: 'status' })).toMatchObject({ state: 'asking', cards: [{ requestId: 'a-1', answerable: false }] })
      const card = await handleIn(giver, target, 'a-1')
      // Not by the tool: the turn carries two senders' work
      expect(await w.mgr.agentSession(giver, { sessionId: target, action: 'answer', card, text: 'allow' })).toMatchObject({ ok: false, error: expect.stringContaining('not your work alone') })
      // Nor by a message: the card's answer is its buttons, or the gate's tool
      try {
        mail.m.service.send(addressOf(giver), { to: [addressOf(target)], text: 'allow', replyTo: mail.told(giver, target)[0]!.message.id })
      } catch {
        // A reply to Centralu's notice may be refused: either way it answers nothing
      }
    }
    expect(cards.answered).toEqual([])
    expect(w.mgr.sessionInfo(target)?.pendingApproval?.requestId).toBe('a-1')
    // The person answers it on the card
    w.mgr.inputs.respondApproval(target, 'a-1', 'allow')
    expect(cards.answered).toEqual([{ requestId: 'a-1', decision: 'allow' }])
  })

  it('tells each sender on its own: one that cannot be told leaves the others told', async () => {
    const [a, b] = [await w.callerSession(), await w.callerSession()]
    const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const cards = answering(handleOf(target))
    void w.mgr.askProject(a, { project: w.target.name, session: target, task: 'migrate it' })
    await w.until(() => handleOf(target).sent.length === 1)
    expect(await w.mgr.askProject(b, { project: w.target.name, session: target, task: 'and seed it' })).toMatchObject({ ok: true, state: 'mailed' })
    await mail.deliver(target)
    const tell = w.mgr.mail.cards.tell.bind(w.mgr.mail.cards)
    vi.spyOn(w.mgr.mail.cards, 'tell').mockImplementation((giver, ...rest) => {
      if (giver === a) throw new Error('disk full')
      return tell(giver, ...rest)
    })
    cards.approval('a-1')
    expect(mail.told(a, target)).toEqual([])
    expect(mail.told(b, target)).toHaveLength(1)
  })

  it('takes back a notice not given yet once its card is void: the turn ended, or the person stopped it', async () => {
    for (const end of ['turn ends', 'stopped'] as const) {
      const { parent, child, cards } = await parentAndChild()
      cards.approval('a-1')
      expect(mail.told(parent, child)).toHaveLength(1)
      expect(mail.m.service.wakingFor(addressOf(parent))).toBe(true)
      if (end === 'turn ends') handleOf(child).answer('done without it')
      else handleOf(child).event({ type: 'state_change', sessionId: child, state: 'waiting_input', reason: 'interrupted' })
      await w.until(() => mail.told(parent, child).length === 0)
      // The parent hears what the turn's end says (its last response, or the stop notice), and nothing of the card
      await mail.deliver(parent)
      expect(shownIn(parent, child)).toEqual([])
    }
  })

  it('tells no one of a card in a later turn the person started, once the work it gave was answered', async () => {
    const { parent, child, cards } = await parentAndChild()
    handleOf(child).answer('schema written')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    await w.mgr.inputs.send(child, 'now also add an index')
    cards.ask('q-person')
    await new Promise((r) => setTimeout(r, 30))
    expect(mail.told(parent, child)).toEqual([])
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'status' })).not.toMatchObject({ state: 'asking' })
    expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', text: 'x' })).toMatchObject({ ok: false })
    expect(cards.answered).toEqual([])
  })

  it('tells an ask_project caller of its target\'s question, which it answers across projects while its work is open', async () => {
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
    // Its work was answered: nothing of that session is the caller's any more
    expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'status' })).toMatchObject({ ok: false })
  })

  it('tells the Assistant of a card in work it sent with reportBack, which it reads with read_session and answers; a send without it asks for nothing back', async () => {
    const orch = await w.mgr.assistant()
    const tools = (w.mgr as unknown as { centraluToolsFor(id: string): import('../adapters/contract.js').CentraluTools }).centraluToolsFor(orch.id)
    const silent = await session()
    const quiet = answering(handleOf(silent))
    expect(await tools.sendToSession(silent, 'build it', false)).toEqual({ ok: true })
    quiet.ask('q-s')
    expect(mail.told(orch.id, silent)).toEqual([])
    expect((await tools.readSession(silent)).cards).toBeUndefined()

    const worker = await session()
    const cards = answering(handleOf(worker))
    expect(await tools.sendToSession(worker, 'build it', true)).toEqual({ ok: true })
    cards.ask('q-o')
    expect(mail.told(orch.id, worker)).toHaveLength(1)
    const read = await runCentraluTool(tools, 'read_session', { sessionId: worker }, { sessionId: orch.id, profile: 'assistant' })
    expect(read.text).toContain('Which database')
    expect(read.text).toContain('answer_question')
    const read2 = await tools.readSession(worker)
    expect(await tools.answerQuestion({ sessionId: worker, card: read2.cards?.[0]?.card, text: 'Postgres' })).toMatchObject({ ok: true, state: 'answered' })
    expect(cards.answered).toHaveLength(1)
  })

  it('does not let the Assistant answer a card in the person\'s turn its task joined', async () => {
    const orch = await w.mgr.assistant()
    await w.mgr.updateSettings(orch.id, { permissionPreset: 'auto' })
    const worker = await session()
    const cards = answering(handleOf(worker))
    await w.mgr.inputs.send(worker, 'the person\'s own work')
    const tools = (w.mgr as unknown as { centraluToolsFor(id: string): import('../adapters/contract.js').CentraluTools }).centraluToolsFor(orch.id)
    await tools.sendToSession(worker, 'also this', true)
    handleOf(worker).acceptsAtOnce = true
    await mail.deliver(worker)
    cards.ask('q-p')
    expect(mail.told(orch.id, worker)).toHaveLength(1)
    expect(mail.told(orch.id, worker)[0]!.message.body).toContain('Only the person can answer it')
    expect(await tools.answerQuestion({ sessionId: worker, card: (await tools.readSession(worker)).cards?.[0]?.card, text: 'Postgres' })).toMatchObject({ ok: false })
    expect(cards.answered).toEqual([])
  })
})

describe('what a giver of work may answer (#679 review)', () => {
  let w: CrossWorld
  let mail: ReturnType<typeof mailOn>
  beforeEach(async () => {
    w = await crossWorld()
    mail = mailOn(w)
  })
  afterEach(async () => {
    mail.m.delivery.stop()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const cardsOf = async (caller: string, session: string) => {
    const r = await w.mgr.agentSession(caller, { sessionId: session, action: 'status' })
    return r.ok && r.state === 'asking' ? r.cards : []
  }
  const centraluTools = (id: string) => (w.mgr as unknown as { centraluToolsFor(id: string): import('../adapters/contract.js').CentraluTools }).centraluToolsFor(id)

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
        const card = r?.ok && r.state === 'asking' ? r.cards[0]! : undefined
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
      const orch = await w.mgr.assistant()
      await w.mgr.updateSettings(orch.id, { permissionPreset: 'auto' })
      const tools = centraluTools(orch.id)
      const run = async (preset: PermissionPreset) => {
        const worker = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
        const cards = answering(handleOf(worker))
        await tools.sendToSession(worker, 'clean the build', true)
        cards.approval('a-1')
        const read = await tools.readSession(worker)
        return { told: mail.told(orch.id, worker)[0]!.message.body, answer: await tools.answerQuestion({ sessionId: worker, card: read.cards?.[0]?.card, text: 'allow' }), cards }
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
      const sending = w.mgr.sendWork(parent, child, 'clean the build')
      await w.until(() => (handleOf(child).sent.at(-1) ?? '').includes('clean the build'))
      expect(await sending).toMatchObject({ ok: true, state: 'working' })
      const cards = answering(handleOf(child))
      cards.approval('a-1')
      const r = await w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
      expect(r).toMatchObject({ ok: true, state: 'asking', cards: [{ kind: 'approval', answerable: false }] })
      const card = r.ok && r.state === 'asking' ? r.cards[0]!.card : ''
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card, text: 'allow' })).toMatchObject({ ok: false, error: expect.stringContaining('safe') })
      expect(cards.answered).toEqual([])
    })
  })

  describe('a task that joins the person\'s turn is told of its cards, and answers none of them', () => {
    it('ask_project into the person\'s turn', async () => {
      const caller = await w.callerSession()
      // Under auto, which may answer a card of a turn that is its work alone
      await w.mgr.updateSettings(caller, { permissionPreset: 'auto' })
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      const cards = answering(handleOf(target))
      await w.mgr.inputs.send(target, "the person's own work")
      // The task goes as mail, and joins the person's turn (docs/plans/mailbox.md §10.6.3): that turn is not the caller's alone
      expect(await w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'also this' })).toMatchObject({ ok: true, state: 'mailed' })
      handleOf(target).acceptsAtOnce = true
      await mail.deliver(target)
      expect(handleOf(target).sent).toHaveLength(2)
      cards.ask('q-person')
      cards.approval('a-person')
      expect(mail.told(caller, target)).toHaveLength(2)
      const standing = await cardsOf(caller, target)
      expect(standing.map((c) => c.answerable)).toEqual([false, false])
      for (const card of standing) {
        expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'answer', card: card.card, text: card.kind === 'question' ? 'Postgres' : 'allow' })).toMatchObject({ ok: false })
      }
      expect(cards.answered).toEqual([])
    })

    it('an auto parent\'s send into the turn the person started in its child', async () => {
      w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      const parent = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'auto' })).id
      const started = await w.mgr.startAgent(parent, { task: 'first', wait: false })
      if (!started.ok) throw new Error(started.error)
      const child = started.sessionId
      handleOf(child).answer('first done')
      await w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
      await w.mgr.inputs.send(child, "the person's own work")
      expect(await w.mgr.sendWork(parent, child, 'a note')).toMatchObject({ ok: true, state: 'mailed' })
      handleOf(child).acceptsAtOnce = true
      await mail.deliver(child)
      expect(handleOf(child).sent.some((t) => t.includes('a note'))).toBe(true)
      const cards = answering(handleOf(child))
      cards.approval('a-person')
      const [card] = await cardsOf(parent, child)
      expect(card).toMatchObject({ requestId: 'a-person', answerable: false })
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: card!.card, text: 'allow' })).toMatchObject({ ok: false })
      expect(cards.answered).toEqual([])
    })
  })

  it('tells, and lets no one answer, a card in a turn the mailbox started for a task that reached a busy session, as the turn owner never was there', async () => {
    const caller = await w.callerSession()
    await w.mgr.updateSettings(caller, { permissionPreset: 'auto' })
    const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const cards = answering(handleOf(target))
    await w.mgr.inputs.send(target, "the person's own work")
    expect(await w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'then this' })).toMatchObject({ ok: true, state: 'mailed' })
    // The person's turn ends before the task is given: the task starts a turn of its own, by mail
    handleOf(target).answer('person work done')
    await eventually(() => w.mgr.sessionInfo(target)?.state !== 'working')
    await mail.deliver(target)
    await eventually(() => handleOf(target).sent.some((t) => t.includes('then this')))
    cards.approval('a-mailed')
    expect(mail.told(caller, target)).toHaveLength(1)
    const [card] = await cardsOf(caller, target)
    expect(card).toMatchObject({ requestId: 'a-mailed', answerable: false })
    expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'answer', card: card!.card, text: 'allow' })).toMatchObject({ ok: false })
    expect(cards.answered).toEqual([])
  })

  it('writes the person no notice of a card in their own work: they have the card itself', async () => {
    const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    mail.m.service.task(PERSON, addressOf(target), { text: 'the script asks', origin: 'mail', delivered: true })
    answering(handleOf(target)).approval('a-person-work')
    expect(mail.read.to(addressOf(PERSON))).toEqual([])
    expect(w.store.mailbox.watchedTo(addressOf(target))).toHaveLength(1)
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
      const read = (await cardsOf(parent, child))[0]!.card
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: read, text: 'Postgres' })).toMatchObject({ ok: true, state: 'answered' })
      // The answered card's notice, not given yet, went with it; a new process asks something else under the same id, told anew
      expect(mail.told(parent, child)).toEqual([])
      cards.ask('req-1', [OTHER])
      expect(mail.told(parent, child).map((t) => t.message.facts.card?.handle)).toEqual([expect.not.stringMatching(read)])
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: read, text: 'SQLite' })).toMatchObject({ ok: false, error: expect.stringContaining('replaced') })
      expect(cards.answered).toEqual([{ requestId: 'req-1', answers: [{ question: QUESTION.question, answers: ['Postgres'] }] }])
      // The card it reads now is the new one
      const now = (await cardsOf(parent, child))[0]!
      expect(now.card).not.toBe(read)
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: now.card, text: 'No' })).toMatchObject({ ok: true, state: 'answered' })
    })

    it('refuses a handle from an earlier turn, even for the same id and question', async () => {
      const { parent, child } = await parentAndChild()
      let cards = answering(handleOf(child))
      cards.ask('req-1')
      const read = (await cardsOf(parent, child))[0]!.card
      w.mgr.inputs.answerQuestion(child, 'req-1', [{ question: QUESTION.question, answers: ['Postgres'] }])
      handleOf(child).answer('schema written')
      await w.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
      const next = w.mgr.sendWork(parent, child, 'and the index')
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
      expect(await w.mgr.agentSession(parent, { sessionId: child, action: 'answer', text: 'SQLite' })).toMatchObject({ ok: false, error: expect.stringContaining('Name the card') })
    })
  })
})

describe('a card handle is bound to the turn the mailbox recorded (#1948 review)', () => {
  it('differs across two turns with no stored row between them, for the same request id and question', () => {
    let turn = 4
    const meta = new Map([['s', { id: 's', pendingQuestions: [{ requestId: 'req-1', questions: [QUESTION] }] }]])
    const host = {
      meta,
      children: { latestTurnRows: () => ({ after: 7 }) },
      mail: { cards: { givers: () => ({ givers: ['g'], answerer: 'g' }), turn: () => turn } },
    } as unknown as RoutedCardsHost
    const cards = new RoutedCards(host)
    const first = cards.routedCards('s', 'g')[0]!.card
    turn = 5
    expect(cards.routedCards('s', 'g')[0]!.card).not.toBe(first)
  })
})

describe('cards across a host restart (#676, docs/plans/mailbox.md §10.6.4)', () => {
  let w: CrossWorld
  const hosts: SessionManager[] = []
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.tenure.disposeAll()
    await w.dispose()
  })

  /** A host on the world's store, its mail wired; `updateResume` is the data folder's lists of the turns an update cut (#1618) */
  const host = (updateResume?: UpdateResumeFolder) => {
    const claude = new CrossAdapter('claude')
    const mgr = new SessionManager(w.store, new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', new CrossAdapter('codex')]]), () => {}, undefined, undefined, updateResume ? { updateResume } : {})
    hosts.push(mgr)
    const m = wireHostMail(mgr, w.store)
    return { mgr, claude, m }
  }
  /** A parent and the child it started on `h`, the child asking q-1 in the turn the parent's task opened; its notice is written and not given */
  const askedOn = async (h: ReturnType<typeof host>) => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const parent = (await h.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    const r = await h.mgr.startAgent(parent, { task: 'write the schema', wait: false })
    if (!r.ok) throw new Error(r.error)
    h.claude.handles.get(parent)!.externalId = 'ext-parent'
    h.claude.handles.get(r.sessionId)!.externalId = 'ext-child'
    answering(h.claude.handles.get(r.sessionId)!).ask('q-1')
    return { parent, child: r.sessionId }
  }
  const told = (giver: string, session: string) => mailReader(w.store).to(addressOf(giver)).filter((x) => x.message.facts.card?.session === addressOf(session))

  it('tells the parent of a card in the turn the next host continues after an update cut it, once per card', async () => {
    const f = memoryUpdateFolder()
    const first = host(f)
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const parent = (await first.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    const r = await first.mgr.startAgent(parent, { task: 'write the schema', wait: false })
    if (!r.ok) throw new Error(r.error)
    const child = r.sessionId
    first.claude.handles.get(parent)!.externalId = 'ext-parent'
    first.claude.handles.get(child)!.externalId = 'ext-child'
    answering(first.claude.handles.get(child)!).ask('q-1')
    expect(told(parent, child)).toHaveLength(1)
    // A linked hub's update stops the host while the parent's work runs
    first.mgr.tenure.stopForUpdate()
    await first.mgr.tenure.disposeAll()
    expect(f.turns()?.map((t) => t.id)).toContain(child)

    const next = host(f)
    await w.until(() => (next.claude.handles.get(child)?.sent.length ?? 0) === 1)
    // The parent's task is still open: a card in the continued turn is told, and the parent answers it
    const cards = answering(next.claude.handles.get(child)!)
    cards.ask('q-2')
    expect(told(parent, child)).toHaveLength(2)
    const standing = await next.mgr.agentSession(parent, { sessionId: child, action: 'status' })
    expect(standing).toMatchObject({ state: 'asking', cards: [{ requestId: 'q-2' }] })
    expect(await next.mgr.agentSession(parent, { sessionId: child, action: 'answer', card: standing.ok && standing.state === 'asking' ? standing.cards[0]!.card : '', text: 'Postgres' })).toMatchObject({ ok: true, state: 'answered' })
    expect(cards.answered).toHaveLength(1)
  })

  it('takes back a notice not given yet when the turn the next host continues after an update ends without its card', async () => {
    const f = memoryUpdateFolder()
    const first = host(f)
    const { parent, child } = await askedOn(first)
    expect(told(parent, child).map((x) => x.row.deliveredAt)).toEqual([null])
    first.mgr.tenure.stopForUpdate()
    await first.mgr.tenure.disposeAll()

    const next = host(f)
    await w.until(() => (next.claude.handles.get(child)?.sent.length ?? 0) === 1)
    next.claude.handles.get(child)!.answer('schema written')
    await w.until(() => told(parent, child).length === 0)
  })

  it('takes back at the next start a notice not given yet whose card a quit took with it', async () => {
    const first = host()
    const { parent, child } = await askedOn(first)
    expect(told(parent, child)).toHaveLength(1)
    await first.mgr.tenure.disposeAll()

    const next = host()
    next.m.afterReady()
    next.m.delivery.stop()
    expect(told(parent, child)).toEqual([])
  })

  it('drops the delegated turns an earlier build left, which this build neither reads nor writes', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const first = host()
    const parent = (await first.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    const r = await first.mgr.startAgent(parent, { task: 'write the schema', wait: false })
    if (!r.ok) throw new Error(r.error)
    const db = (w.store as unknown as { db: { prepare(sql: string): { all(): unknown[]; run(...a: unknown[]): unknown } } }).db
    const rows = () => db.prepare('SELECT session_id AS sessionId, caller_session_id AS callerId FROM delegated_turns').all()
    expect(rows()).toEqual([])
    await first.mgr.tenure.disposeAll()
    // An earlier build's row for a turn it gave, as beta.57 writes it
    db.prepare(`INSERT INTO delegated_turns (session_id, caller_session_id, started_at, told_cards, turn_id) VALUES (?, ?, 1, 'q-1.abcd1234', 't-1')`).run(r.sessionId, parent)
    host()
    expect(rows()).toEqual([])
  })
})
