/**
 * SessionManager through RPC with an in-memory adapter: messages, approvals and what the store keeps of a turn.
 * Shared fakes and the world each test starts from are in manager.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NormalizedEvent, SessionInfo, StoredMessage } from '@cc/protocol'
import { NormalizedEvent as NormalizedEventSchema } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import type { ChildOwnership } from './child-ownership.js'
import type { RestartPolicy } from './restart-policy.js'
import { normalizeNotification } from '../adapters/codex/normalize.js'
import { createRpcHandler } from '../rpc.js'
import { FakeAdapter, managerWorld } from './manager.test-helpers.js'

let store: Store
let adapter: FakeAdapter
let codexAdapter: FakeAdapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  ;({ store, adapter, codexAdapter, mgr, events, rpc } = managerWorld())
})

const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string; path: string }>

describe('approvals, read state, and messages', () => {
  it('an approval response is delivered to the adapter', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r1', decision: 'allow' })
    expect(adapter.last!.approvals).toEqual([{ requestId: 'r1', decision: 'allow' }])
  })

  /*
   * A session was completely stuck during dogfooding: the screen showed "Awaiting approval"
   * with no reaction to clicking it, while the backend's session state was actually idle.
   *
   * The cause was process replacement. Changing a permission preset makes the manager swap the
   * process (the drift path in updateSettings), and the new process's approval map starts empty.
   * So the requestId of the card that was already up existed nowhere, and the adapter
   * **silently returned** — the screen stayed waiting for an answer forever.
   */
  it('answering a vanished approval reports it and clears the card from the screen', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    adapter.last!.dropApprovals() // simulates the process having been swapped out

    await expect(
      rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r-stale', decision: 'allow' }),
    ).rejects.toMatchObject({ code: 'approval_gone' })

    // The screen needs evidence to clear the card — otherwise a card that does not go away when clicked is
    // left behind.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'approval_resolved', sessionId: s.id, requestId: 'r-stale' }),
    )
  })

  /*
   * #158: if y is pressed twice on the card (or once each on the card and the rail), by the time
   * the second response reaches the host the adapter no longer knows that request. Reading that
   * as "the process was swapped" and broadcasting deny makes a command that just ran show up as
   * denied on screen and in the transcript.
   */
  it('a second response to an approval that already landed leaves it alone silently instead of broadcasting a denial', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r1', decision: 'allow' })
    // The adapter removes an answered request from the pending map — a second response with the same id
    // gets false back.
    adapter.last!.dropApprovals()
    await rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r1', decision: 'allow' })

    const resolved = events.filter((e) => e.type === 'approval_resolved' && e.requestId === 'r1')
    expect(resolved).toEqual([expect.objectContaining({ decision: 'allow' })])
    // A request that never landed is still a vanished request.
    await expect(
      rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r2', decision: 'allow' }),
    ).rejects.toMatchObject({ code: 'approval_gone' })
  })

  it("a vanished approval does not leave behind an 'always allow' rule", async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    adapter.last!.dropApprovals()

    await expect(
      rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r1', decision: 'always', matcher: 'git push' }),
    ).rejects.toMatchObject({ code: 'approval_gone' })

    // Remembering a command that never even ran as always-allowed would let it slip through silently next
    // time.
    expect(await rpc('approvals.rules', {})).toEqual([])
  })

  /*
   * #161: the host broadcasts a recorded event carrying a per-session seq. If that event's schema
   * does not spell out `seq`, zod silently strips it, the screen's lastSeq falls behind, and a
   * session that was already read shows an unread dot after a restart (`error` did exactly this).
   * Send every kind that gets recorded, and check that every event carrying a seq still has it
   * after parsing, with none skipped.
   */
  it('events recorded with a seq attached do not lose it after passing through the schema, for every kind', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'hi' })
    const h = adapter.last!
    const raw = (e: Record<string, unknown>) =>
      (h as unknown as { emit: (e: NormalizedEvent) => void }).emit({ sessionId: s.id, ...e } as NormalizedEvent)
    raw({ type: 'reasoning_delta', text: 'thinking' })
    h.emitToolCall('Bash', 'ls')
    raw({ type: 'tool_result', callId: 'c-2', ok: true, summary: 'ok' })
    h.emitApproval('r-seq')
    raw({ type: 'approval_resolved', requestId: 'r-seq', decision: 'allow' })
    raw({ type: 'compaction', failed: false })
    raw({ type: 'conversation_reset', trigger: 'clear' })
    raw({ type: 'notice', level: 'warning', text: 'heads up' })
    raw({ type: 'app_view', callId: 'c-2', appId: 'notes', projectId: null, tool: 'home', phase: 'open' })
    h.emitError('400 bad request')

    const stamped = events.filter((e) => typeof (e as { seq?: unknown }).seq === 'number')
    const kinds = new Set(stamped.map((e) => e.type))
    // Not a vacuous test — the recorded kinds actually went out carrying a seq.
    for (const k of ['user_message', 'message_delta', 'reasoning_delta', 'tool_call', 'tool_result', 'approval_request', 'approval_resolved', 'compaction', 'conversation_reset', 'notice', 'app_view', 'error']) {
      expect(kinds, k).toContain(k)
    }
    for (const e of stamped) {
      const parsed = NormalizedEventSchema.parse(e) as { seq?: number }
      expect(parsed.seq, e.type).toBe((e as { seq: number }).seq)
    }
  })

  it('keeps nothing per session for a turn that ended or a session deleted mid-turn (#392)', async () => {
    const internals = mgr as unknown as {
      events: { pendingCommits: Map<string, string> }
      children: ChildOwnership
      restartPolicy: RestartPolicy
    }
    const p = await addProject()
    const ended = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: ended.id, text: 'commit it' })
    // A commit call interrupted before it answered: its result never comes
    adapter.last!.emitToolCall('Bash', 'git commit -m "wip"')
    expect([...internals.events.pendingCommits.values()]).toEqual([ended.id])
    adapter.last!.finishTurn()
    expect(internals.events.pendingCommits.size).toBe(0)

    const gone = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: gone.id, text: 'commit it' })
    adapter.last!.emitToolCall('Bash', 'git commit -m "wip"')
    // What its turn's end would have consumed: an orchestrator's report, a restart for an app change
    internals.children.adoptReport(gone.id, 'orchestrator', null)
    internals.restartPolicy.appsRestartAfterTurn.add(gone.id)
    await rpc('agents.deleteSession', { sessionId: gone.id })
    expect(internals.events.pendingCommits.size).toBe(0)
    expect(internals.children.awaitingReport.has(gone.id)).toBe(false)
    expect(internals.restartPolicy.appsRestartAfterTurn.has(gone.id)).toBe(false)
  })

  it('messages are persisted and reloaded', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'First message' })
    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 100 })) as { role: string }[]
    expect(msgs.length).toBeGreaterThanOrEqual(2) // user + adapter delta
    expect(msgs[0]!.role).toBe('user')
  })

  it('a message I sent is automatically marked as read', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'x' })
    const list = (await rpc('sessions.list', {})) as { lastReadSeq: number }[]
    expect(list[0]!.lastReadSeq).toBeGreaterThan(0)
  })

  it('markRead does not go backward', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('sessions.markRead', { sessionId: s.id, seq: 10 })
    await rpc('sessions.markRead', { sessionId: s.id, seq: 3 })
    const list = (await rpc('sessions.list', {})) as { lastReadSeq: number }[]
    expect(list[0]!.lastReadSeq).toBe(10)
  })
})

/**
 * A session created with an initial prompt. If it is only sent to the adapter and not saved,
 * the record after restarting **starts with the reply** — with no record of what was asked.
 */
describe('the initial prompt is recorded too', () => {
  it('is stored as a user row, and the user_message event carries a seq', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: p.path, tool: 'claude', initialPrompt: 'do this from the start',
    })) as { id: string }

    // it went to the adapter, and
    expect(adapter.last!.sent).toEqual(['do this from the start'])
    // it was recorded too
    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 10 })) as {
      role: string
      seq: number
      payload: { text?: string }
    }[]
    const first = msgs.find((m) => m.role === 'user')!
    expect(first.payload.text).toBe('do this from the start')
    // The seq is how the UI's optimistic rendering recognizes its own message — the same contract as send().
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_message', sessionId: s.id, seq: first.seq, text: 'do this from the start' }),
    )
    // What I sent counts as read — the initial prompt must not trigger an unread badge.
    const after = mgr.listSessions().find((x) => x.id === s.id)!
    expect(after.lastReadSeq).toBeGreaterThanOrEqual(first.seq)
  })
})

/**
 * Worktree sessions (a lower-priority option in FR-2).
 *
 * Tested with a real git repository and a temporary worktree root — a fake could not confirm
 * what this feature has to guarantee (**isolation does not quietly break**).
 */
/**
 * Touched files go out as paths relative to the project (#185). The tool gives absolute paths
 * while the file tree uses relative ones, so the tree's "Edited by agent" marker never once
 * matched.
 */
describe('the path of a touched file (#185)', () => {
  it('converts paths inside the project to relative, and drops the ones outside', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    events.length = 0
    adapter.handleOf(s.id)!.emitTouched([
      join(p.path, 'src', 'a.ts'),
      'src/b.ts', // A relative path is taken relative to the folder the session runs in.
      join(p.path, '..', 'elsewhere.ts'),
      '/etc/hosts',
    ])
    expect(events.find((e) => e.type === 'files_touched')).toMatchObject({ paths: ['src/a.ts', 'src/b.ts'] })
  })

  it('reads a path through a link to the project the same as the project (#428)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    // The other spelling of the project's folder: macOS's temp folder is a link (/var is /private/var)
    const real = realpathSync.native(p.path)
    const other = real === p.path ? tmpdir() : real
    events.length = 0
    adapter.handleOf(s.id)!.emitTouched([join(other, 'src', 'c.ts'), join(other, '..', 'elsewhere.ts')])
    expect(events.find((e) => e.type === 'files_touched')).toMatchObject({ paths: ['src/c.ts'] })
  })
})

/*
 * The unit of storage changed from delta to **message** (#66).
 * A single sentence used to be nine rows — 84% of the DB was fragments, pagination lost meaning
 * by counting rows, and the trigram index could not index 1-2 character bodies, which killed
 * search.
 */
describe('a streaming message is stored as a single row (#66)', () => {
  const openSession = async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    return { s, h: adapter.handleOf(s.id)! }
  }

  it('multiple chunks become one row, and a trailing empty chunk creates no row', async () => {
    const { s, h } = await openSession()
    for (const part of ['한 ', '번에 ', '뽑게 ', '하면 ', '됩니다.']) h.emitDelta(part)
    h.emitDelta('') // The empty delta codex sends at the end — the source of 1,853 empty rows.
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    const rows = store.messages.loadMessages(s.id, 50)
    const texts = rows.filter((r) => r.kind === 'text').map((r) => (r.payload as { text?: string }).text)
    expect(texts).toEqual(['한 번에 뽑게 하면 됩니다.'])
  })

  it('a phrase spanning a chunk boundary is searchable once the turn closes', async () => {
    const { h } = await openSession()
    // "뽑게" straddles two chunks — the kind of thing that could never be found back when a row was a chunk.
    h.emitDelta('한 번에 뽑')
    h.emitDelta('게 하면 됩니다.')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    expect(store.messages.searchMessages('뽑게 하면').length).toBe(1)
  })

  it('a tool call is a message boundary — before and after become separate rows', async () => {
    const { s, h } = await openSession()
    h.emitDelta('먼저 살펴보고')
    h.emitToolCall('Bash', 'ls')
    h.emitDelta('결과는 이렇습니다')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    const rows = store.messages.loadMessages(s.id, 50)
    expect(rows.map((r) => r.kind)).toEqual(['text', 'tool_call', 'text'])
    // A row closed at a boundary is indexed too — what was said before a tool call must not be missing from
    // search.
    expect(store.messages.searchMessages('먼저 살펴보고').length).toBe(1)
  })

  it("a person's message (send) is a boundary too — continuing after an interrupt does not attach to the open row", async () => {
    const { s, h } = await openSession()
    h.emitDelta('what it was saying')
    await new Promise((r) => setTimeout(r, 0))
    await mgr.send(s.id, 'stop, do this first')
    h.emitDelta('new answer')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    const texts = store.messages.loadMessages(s.id, 50).map((r) => (r.payload as { text?: string }).text)
    // The fake handle answers send with an echo delta — since there is no boundary between that echo and
    // "new answer," they correctly form one row.
    expect(texts).toEqual(['what it was saying', 'stop, do this first', 'echo:stop, do this firstnew answer'])
  })

  /*
   * The frames codex-cli 0.153.4 sent while a command ran and the model polled it with `write_stdin`
   * (scripts/probe-codex-message-boundary.mts), from the command's start to the end of the turn. The
   * token-usage and status notifications between them are left out; nothing else is. Between the two
   * commentary messages there is a terminal interaction (not an item) and a reasoning item with no summary
   * text, so nothing the host records.
   */
  const MSG_NOW = 'msg_0c76dd52d2509a27016abfe6b25b1887d0b926d25d4c05f25f'
  const MSG_AGAIN = 'msg_0c76dd52d2509a27016abfe6babe3487d0b8234e8e9d0b4d7b'
  const MSG_DONE = 'msg_0c76dd52d2509a27016abfe6bc240887d0bcd7538c709efc59'
  const EXEC = 'exec-c74246f4-0d0f-4622-be80-ae917d5abbcf'
  const command = { type: 'commandExecution', id: EXEC, command: "/bin/zsh -lc 'sleep 12 && echo finished'" }
  const reasoning = (id: string) => [
    { method: 'item/started', params: { item: { type: 'reasoning', id, summary: [] } } },
    { method: 'item/completed', params: { item: { type: 'reasoning', id, summary: [] } } },
  ]
  const message = (id: string, phase: string, chunks: string[]) => [
    { method: 'item/started', params: { item: { type: 'agentMessage', id, text: '', phase } } },
    ...chunks.map((delta) => ({ method: 'item/agentMessage/delta', params: { itemId: id, delta } })),
    { method: 'item/completed', params: { item: { type: 'agentMessage', id, text: chunks.join(''), phase } } },
  ]
  const MEASURED_POLL = [
    { method: 'item/started', params: { item: { ...command, status: 'inProgress', aggregatedOutput: null, exitCode: null } } },
    ...reasoning('rs_0c76dd52d2509a27016abfe6b224d887d0b808153aa50eb4ec'),
    ...message(MSG_NOW, 'commentary', ['It', ' is', ' still', ' running', ';', ' I', '’m', ' polling', ' it', ' now', '.']),
    { method: 'item/commandExecution/terminalInteraction', params: { itemId: EXEC, processId: '86732', stdin: '' } },
    ...reasoning('rs_0c76dd52d2509a27016abfe6ba5f4c87d09b5ffa33363b3f4e'),
    ...message(MSG_AGAIN, 'commentary', ['It', ' is', ' still', ' running', ';', ' I', '’m', ' polling', ' it', ' again', '.']),
    { method: 'item/commandExecution/outputDelta', params: { itemId: EXEC, delta: 'finished\n' } },
    { method: 'item/completed', params: { item: { ...command, status: 'completed', aggregatedOutput: 'finished\n', exitCode: 0 } } },
    ...message(MSG_DONE, 'final_answer', ['done']),
    { method: 'turn/completed', params: { turn: { id: '01a0fd9c-f6bc-77c0-a085-d1306fecfce2', status: 'completed', error: null } } },
  ]

  it('two codex messages with nothing recorded between them are two rows, live and reopened (#212, measured frames)', async () => {
    const { s, h } = await openSession()
    for (const frame of MEASURED_POLL) for (const e of normalizeNotification(s.id, frame)) h.emitEvent(e)
    await new Promise((r) => setTimeout(r, 0))

    const rows = store.messages.loadMessages(s.id, 50)
    expect(rows.map((r) => [r.kind, (r.payload as { text?: string }).text])).toEqual([
      ['tool_call', undefined],
      ['text', 'It is still running; I’m polling it now.'],
      ['text', 'It is still running; I’m polling it again.'],
      ['tool_result', undefined],
      ['text', 'done'],
    ])
    // Live, the screen starts a new bubble when the stored number changes — so each message carries its own
    const liveSeqs = (id: string) =>
      new Set(events.filter((e) => e.type === 'message_delta' && e.messageId === id && e.text).map((e) => (e as { seq?: number }).seq))
    expect([...liveSeqs(MSG_NOW)]).toEqual([rows[1]!.seq])
    expect([...liveSeqs(MSG_AGAIN)]).toEqual([rows[2]!.seq])
  })

  it('chunks that name no message still grow the open row (#212 leaves other tools as they were)', async () => {
    const { s, h } = await openSession()
    h.emitEvent({ type: 'message_delta', sessionId: s.id, role: 'assistant', text: 'one ', messageId: 'm1' })
    h.emitDelta('row')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    expect(store.messages.loadMessages(s.id, 50).map((r) => (r.payload as { text?: string }).text)).toEqual(['one row'])
  })

  it('an attachment is stored as a path in the payload, and loadMessages re-reads the image bytes from the file', async () => {
    const { s } = await openSession()
    const dir = mkdtempSync(join(tmpdir(), 'cc-att-'))
    const img = join(dir, 'shot.png')
    writeFileSync(img, Buffer.from('PNG bytes'))
    await mgr.send(s.id, 'take a look at this screen', [
      { kind: 'image', path: img, name: 'shot.png', mime: 'image/png', bytes: 9 },
      // A file removed by the 500MB cap cleanup — only the path remains, and the screen shows it as a name
      // chip.
      { kind: 'image', path: join(dir, 'gone.png'), name: 'gone.png', mime: 'image/png', bytes: 9 },
    ])

    // The DB has no bytes (D-1: path only).
    const raw = store.messages.loadMessages(s.id, 50).find((r) => r.role === 'user')!
    const rawAtts = (raw.payload as { attachments: { data?: string }[] }).attachments
    expect(rawAtts.map((a) => a.data)).toEqual([undefined, undefined])

    // Only a file that still exists gets its bytes attached when served to the screen.
    const served = (await mgr.loadMessages(s.id, 50)).find((r) => r.role === 'user')!
    const atts = (served.payload as { attachments: { name: string; data?: string }[] }).attachments
    expect(atts[0]?.data).toBe(Buffer.from('PNG bytes').toString('base64'))
    expect(atts[1]?.data).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * A tool's whole record (#221) — a call's `input`, a result's `output` — is kept in the store and goes nowhere else.
 *
 * Not to the UI: one `cat` of a large file would ride the broadcast and every history page. And not to another session
 * (#73): `read_session`, `recall`, the handoff record, `list_sessions` and the orchestrator's memory read the card at
 * most. The secrets below sit where the card does not reach — past the result's first 300 characters, and in an input
 * field the title does not show — so any of them turning up means the record leaked.
 */
describe('a tool call is kept whole in the store and leaves it only as its card (#221, #73)', () => {
  const INPUT_SECRET = 'INPUT_SECRET_7f3a'
  const OUTPUT_SECRET = 'OUTPUT_SECRET_91c2'
  const output = `${'a line of build log\n'.repeat(40)}token=${OUTPUT_SECRET}`
  const input = { command: 'npm run build', description: `build it (${INPUT_SECRET})` }

  const setup = async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    await rpc('agents.send', { sessionId: a.id, text: 'build the package' })
    adapter.handleOf(a.id)!.emitToolRecord('c-build', 'npm run build', input, output)
    await new Promise((r) => setTimeout(r, 0))
    return { p, a }
  }
  const leaks = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return [INPUT_SECRET, OUTPUT_SECRET].filter((s) => text.includes(s))
  }

  it('the store keeps it, and the UI gets the card: neither the live broadcast nor a history page carries it', async () => {
    const { a } = await setup()
    const full = store.messages.loadMessages(a.id, 50, undefined, { full: true }).filter((r) => r.kind === 'tool_call' || r.kind === 'tool_result')
    expect(full.map((r) => r.payload)).toMatchObject([{ input }, { output }])

    const sent = events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
    expect(sent.map((e) => e.type)).toEqual(['tool_call', 'tool_result'])
    expect(sent[1]).toMatchObject({ summary: output.slice(0, 300), seq: expect.any(Number) })
    expect(leaks(sent)).toEqual([])
    expect(leaks(await rpc('messages.load', { sessionId: a.id, limit: 50 }))).toEqual([])

    await rpc('agents.deleteSession', { sessionId: a.id })
    expect(leaks(await rpc('trash.read', { sessionId: a.id }))).toEqual([])
  })

  it('another session never reads it: read_session, recall, search, list_sessions, the handoff record, the memory', async () => {
    const { a } = await setup()
    // Every reader below reads the store; what the store hands out by default is the card
    expect(leaks(store.messages.loadMessages(a.id, 50))).toEqual([])
    expect(leaks(store.messages.loadMessagesFrom(a.id, 0, 50))).toEqual([])

    const orc = await mgr.orchestrator()
    const tools = adapter.lastOrchestratorTools!
    expect(leaks(await tools.readSession(a.id, 40, { tools: true }))).toEqual([])
    expect(leaks(await mgr.runOrchestratorTool(orc.id, 'read_session', { sessionId: a.id, tools: true }))).toEqual([])
    for (const q of [INPUT_SECRET, OUTPUT_SECRET, 'npm run build']) {
      expect((await tools.recall(q)).hits).toEqual([])
      expect(await rpc('messages.search', { query: q })).toEqual([])
    }
    expect(leaks(await tools.listSessions())).toEqual([])

    const record = await mgr.exportHandoffRecord(a.id, 'codex')
    expect(record.text).toContain('npm run build') // the card is there…
    expect(leaks(record.text)).toEqual([]) // …and the record is not
    expect(leaks(readFileSync(record.path, 'utf8'))).toEqual([])

    // The orchestrator's own tool calls are not carried into its next process's prompt either
    adapter.handleOf(orc.id)!.emitToolRecord('c-orc', 'npm run build', input, output)
    await mgr.switchTool(orc.id, 'codex')
    await mgr.resumeSession(orc.id)
    expect(leaks(codexAdapter.lastOpts?.systemPromptAppend ?? '')).toEqual([])
  })
})

/**
 * What a native subagent did (#222) is kept under the card that launched it, and read by nothing but a request for that
 * card's steps.
 *
 * Every reader of a session reads its conversation: a history page, unread, the handoff record and note, `read_session`,
 * `recall`, search, `list_sessions`, the orchestrator's memory. None of them may see a subagent's steps — its tool
 * output reaching another session's prompt is the path #73 closed — and none may count them. The subagent's words may go
 * to the screen that opens its card (the broadcast, `messages.subagent`); its tool input and output go nowhere.
 */
describe("a subagent's steps are kept under its launch card and read by nothing else (#222, #73)", () => {
  const AGENT = 'toolu_agent_launch'
  const INPUT_SECRET = 'SUB_INPUT_SECRET_5d1e'
  const OUTPUT_SECRET = 'SUB_OUTPUT_SECRET_0b77'
  const WORDS = 'SUBAGENT_WORDS_e48c'
  const THOUGHT = 'SUBAGENT_THOUGHT_a9f0'
  const output = `${'a line of grep output\n'.repeat(40)}token=${OUTPUT_SECRET}`

  const step = (sessionId: string, s: Record<string, unknown>): NormalizedEvent =>
    ({ type: 'subagent_event', sessionId, parentCallId: AGENT, step: { sessionId, ...s } }) as NormalizedEvent
  const subagentWork = (sessionId: string): NormalizedEvent[] => [
    step(sessionId, { type: 'reasoning_delta', text: `first ${THOUGHT}` }),
    step(sessionId, { type: 'tool_call', callId: 'toolu_sub', summary: { tool: 'Grep', title: 'Grep: boundaries', paths: [] }, input: { pattern: INPUT_SECRET } }),
    step(sessionId, { type: 'tool_result', callId: 'toolu_sub', ok: true, summary: output.slice(0, 300), output }),
    step(sessionId, { type: 'message_delta', role: 'assistant', text: `The boundaries test holds. ${WORDS}` }),
  ]

  /** A parent mid-answer when its subagent's steps arrive, as a background agent's do (#98's measured ordering) */
  const setup = async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    await rpc('agents.send', { sessionId: a.id, text: 'look into the boundaries test' })
    const h = adapter.handleOf(a.id)!
    h.emitEvent({ type: 'tool_call', sessionId: a.id, callId: AGENT, summary: { tool: 'Agent', title: 'Research the boundaries', paths: [] } })
    h.emitDelta('While it works, ')
    const lastSeq = () => store.sessions.listSessions().find((s) => s.id === a.id)!.lastSeq
    const before = lastSeq()
    for (const e of subagentWork(a.id)) h.emitEvent(e)
    h.emitDelta('here is what I know.')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))
    return { p, a, h, before, lastSeq }
  }
  const leaks = (value: unknown, secrets = [INPUT_SECRET, OUTPUT_SECRET, WORDS, THOUGHT]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return secrets.filter((s) => text.includes(s))
  }

  it('the store keeps every step whole under the launch call, numbered within that launch', async () => {
    const { a } = await setup()
    const full = store.messages.loadSubagentMessages(a.id, AGENT, { full: true })
    expect(full.map((r) => [r.seq, r.role, r.kind])).toEqual([
      [1, 'assistant', 'reasoning'],
      [2, 'system', 'tool_call'],
      [3, 'system', 'tool_result'],
      [4, 'assistant', 'text'],
    ])
    expect(full.map((r) => r.payload)).toMatchObject([{}, { input: { pattern: INPUT_SECRET } }, { output }, {}])
    // Another card's steps are another card's
    expect(store.messages.loadSubagentMessages(a.id, 'toolu_other')).toEqual([])
  })

  it('the conversation is the parent\'s alone: no row, no seq, and the parent\'s paragraph is not split', async () => {
    const { a, before, lastSeq } = await setup()
    const rows = store.messages.loadMessages(a.id, 50, undefined, { full: true })
    expect(leaks(rows)).toEqual([])
    // The person's message, the fake adapter's echo of it, the Agent card, and the parent's paragraph in one row
    expect(rows.map((r) => `${r.role}:${r.kind}`)).toEqual(['user:text', 'assistant:text', 'system:tool_call', 'assistant:text'])
    expect((rows[3]!.payload as { text: string }).text).toBe('While it works, here is what I know.')
    // Unread counts the conversation: the steps moved no seq, so a session read up to its last message stays read
    expect(lastSeq()).toBe(before)
    expect(lastSeq()).toBe(rows.at(-1)!.seq)
  })

  it('the screen gets each step as its card, numbered within its launch and never as a conversation seq', async () => {
    const { a } = await setup()
    const sent = events.filter((e) => e.type === 'subagent_event')
    expect(sent.map((e) => (e as { stepSeq: number }).stepSeq)).toEqual([1, 2, 3, 4])
    expect(sent.some((e) => 'seq' in e)).toBe(false)
    expect(leaks(sent, [INPUT_SECRET, OUTPUT_SECRET])).toEqual([])
    expect(sent.at(-1)).toMatchObject({ parentCallId: AGENT, step: { type: 'message_delta', text: `The boundaries test holds. ${WORDS}` } })

    // Opening the card reads them, as cards
    const page = (await rpc('messages.subagent', { sessionId: a.id, parentCallId: AGENT })) as StoredMessage[]
    expect(page.map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect(leaks(page, [INPUT_SECRET, OUTPUT_SECRET])).toEqual([])
    expect(leaks(page, [WORDS, THOUGHT])).toEqual([WORDS, THOUGHT])
    // Paging forward
    expect(((await rpc('messages.subagent', { sessionId: a.id, parentCallId: AGENT, afterSeq: 2, limit: 1 })) as StoredMessage[]).map((r) => r.seq)).toEqual([3])
    // A history page never carries them
    expect(leaks(await rpc('messages.load', { sessionId: a.id, limit: 50 }))).toEqual([])
  })

  it('another session never reads them: read_session, recall, search, list_sessions, the handoff record and note, the memory', async () => {
    const { a, h } = await setup()
    const orc = await mgr.orchestrator()
    const tools = adapter.lastOrchestratorTools!
    expect(leaks(await tools.readSession(a.id, 40, { tools: true }))).toEqual([])
    expect(leaks(await mgr.runOrchestratorTool(orc.id, 'read_session', { sessionId: a.id, tools: true }))).toEqual([])
    for (const q of [INPUT_SECRET, OUTPUT_SECRET, WORDS, THOUGHT]) {
      expect((await tools.recall(q)).hits).toEqual([])
      expect(await rpc('messages.search', { query: q })).toEqual([])
    }
    expect(leaks(await tools.listSessions())).toEqual([])

    const record = await mgr.exportHandoffRecord(a.id, 'codex')
    expect(record.text).toContain('here is what I know.')
    expect(leaks(record.text)).toEqual([])
    expect(leaks(readFileSync(record.path, 'utf8'))).toEqual([])

    // A handoff note is the parent's last words after the request — a subagent finishing later does not replace them
    const asked = store.sessions.listSessions().find((s) => s.id === a.id)!.lastSeq
    await rpc('agents.send', { sessionId: a.id, text: 'write the handoff note' })
    h.emitDelta('NOTE: the boundaries test holds.')
    h.finishTurn()
    for (const e of subagentWork(a.id)) h.emitEvent(e)
    await new Promise((r) => setTimeout(r, 0))
    const note = (await mgr.exportHandoffNote(a.id, asked))?.text ?? ''
    expect(note).toMatch(/NOTE: the boundaries test holds\.$/)
    expect(leaks(note)).toEqual([])

    // The orchestrator's own subagent is not carried into its next process's prompt either
    for (const e of subagentWork(orc.id)) adapter.handleOf(orc.id)!.emitEvent(e)
    await mgr.switchTool(orc.id, 'codex')
    await mgr.resumeSession(orc.id)
    expect(leaks(codexAdapter.lastOpts?.systemPromptAppend ?? '')).toEqual([])
  })

  it('they follow the session into the session archive and back, and go with it for good', async () => {
    const { a } = await setup()
    await rpc('agents.deleteSession', { sessionId: a.id })
    expect(leaks(await rpc('trash.read', { sessionId: a.id }))).toEqual([])
    expect((await rpc('messages.subagent', { sessionId: a.id, parentCallId: AGENT }) as StoredMessage[]).length).toBe(4)
    await rpc('trash.restore', { sessionId: a.id })
    expect(store.messages.loadSubagentMessages(a.id, AGENT).length).toBe(4)
    await rpc('agents.deleteSession', { sessionId: a.id })
    await rpc('trash.purge', { sessionId: a.id })
    expect(store.messages.loadSubagentMessages(a.id, AGENT)).toEqual([])
  })
})

/**
 * A failed turn **is recorded** (#107).
 *
 * An error used to only change state and pass through — with no row saved, a turn that died with
 * a 400 left an empty reply in its place, and reopening it gave no way to know why it was empty.
 * The shape of a real incident: the rollout had the full text, and the app had not one character
 * of it.
 */
describe('a failed turn is recorded (#107)', () => {
  it('an error is stored as a marker row, and the session state becomes error', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    adapter.handleOf(s.id)!.emitError("The 'opus[1m]' model is not supported")

    const rows = store.messages.loadMessages(s.id, 50)
    const marker = rows.find((r) => r.kind === 'marker')
    expect(marker).toBeDefined()
    expect(marker!.payload).toMatchObject({ type: 'error', error: { message: "The 'opus[1m]' model is not supported" } })

    const listed = (await rpc('sessions.list', {})) as SessionInfo[]
    expect(listed.find((x) => x.id === s.id)?.state).toBe('error')
  })
})

/**
 * What the agent tools tell the person (#304): a fresh conversation, a notice, a model switch the tool made. The
 * shapes are what the adapters emit for the measured payloads (Claude's `/clear` and hook block, Codex's
 * configuration warning).
 */
describe('resets, notices and switches the tool made (#304)', () => {
  const start = async (model?: string) => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal', ...(model ? { model } : {}),
    })) as SessionInfo
    return { p, s, h: adapter.last! }
  }
  const markers = (sessionId: string) =>
    store.messages.loadMessages(sessionId, 100).filter((r) => r.kind === 'marker').map((r) => r.payload as { type: string; text?: string })

  it('what the tool says while a new session is starting is recorded once the session exists (codex configWarning)', async () => {
    const p = await addProject()
    const text = 'Codex is ignoring 2 unrecognized configuration settings.'
    const create = adapter.createSession.bind(adapter)
    adapter.createSession = async (opts, emit) => {
      // Measured: configWarning arrives while thread/start is answered, before the adapter hands its session back
      emit({ type: 'notice', sessionId: opts.sessionId, level: 'warning', text, oncePerSession: true })
      const h = await create(opts, emit)
      h.emitEvent({ type: 'notice', sessionId: opts.sessionId, level: 'warning', text, oncePerSession: true })
      return h
    }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo

    expect(markers(s.id).map((m) => m.text)).toEqual([text])
    const sent = events.filter((e) => e.sessionId === s.id).map((e) => [e.type, (e as { seq?: number }).seq])
    expect(sent).toEqual([['session_created', undefined], ['notice', 1]])
  })

  it('a reset is a marker in the record and empties the context gauge', async () => {
    const { s, h } = await start()
    h.emitContext(15967, 200000)
    h.emitEvent({ type: 'conversation_reset', sessionId: s.id, trigger: 'clear' })

    expect(markers(s.id)).toEqual([expect.objectContaining({ type: 'conversation_reset', trigger: 'clear' })])
    const sent = events.find((e) => e.type === 'conversation_reset') as { seq?: number }
    expect(typeof sent.seq).toBe('number')
    const listed = ((await rpc('sessions.list', {})) as SessionInfo[]).find((x) => x.id === s.id)!
    expect(listed.context).toBeNull()
  })

  /*
   * A compaction that says its size moves the gauge there (#1282). Seen: the marker said "964k → 8.8k" and the gauge
   * kept "Context 96%", for good once the next turn failed and no turn-end reading came.
   */
  it('a compaction that reports its size moves the context gauge there, as an estimate in the known window (#1282)', async () => {
    const { s, h } = await start()
    const listed = async () => ((await rpc('sessions.list', {})) as SessionInfo[]).find((x) => x.id === s.id)!.context
    // With no reading yet the window is unknown, so the gauge stays empty
    h.emitEvent({ type: 'compaction', sessionId: s.id, failed: false, before: 964_000, after: 8_800 })
    expect(await listed()).toBeNull()

    // A failed one shrank nothing; one with no size (Codex's) waits for the tool's next reading
    h.emitContext(964_000, 1_000_000)
    h.emitEvent({ type: 'compaction', sessionId: s.id, failed: true, reason: 'Not enough messages to compact.' })
    h.emitEvent({ type: 'compaction', sessionId: s.id, failed: false })
    expect(await listed()).toEqual({ used: 964_000, window: 1_000_000, exactness: 'exact' })

    h.emitEvent({ type: 'compaction', sessionId: s.id, failed: false, before: 964_000, after: 8_800 })
    const want = { used: 8_800, window: 1_000_000, exactness: 'estimate' }
    expect(await listed()).toEqual(want)
    // Stored with the session, as a turn-end reading is: the next host reads it back
    expect(store.sessions.listSessions().find((x) => x.id === s.id)!.context).toEqual(want)
  })

  it('a notice is a marker, and one marked once per session is kept once, even across restarts', async () => {
    const { s, h } = await start()
    const warning = 'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.'
    h.emitEvent({ type: 'notice', sessionId: s.id, level: 'warning', text: warning, oncePerSession: true })
    h.emitEvent({ type: 'notice', sessionId: s.id, level: 'warning', text: warning, oncePerSession: true })
    await rpc('agents.restartSession', { sessionId: s.id })
    adapter.last!.emitEvent({ type: 'notice', sessionId: s.id, level: 'warning', text: warning, oncePerSession: true })
    // A notice that is not marked is said every time: a hook blocking two prompts blocked two prompts
    adapter.last!.emitEvent({ type: 'notice', sessionId: s.id, level: 'warning', text: 'blocked by hook' })
    adapter.last!.emitEvent({ type: 'notice', sessionId: s.id, level: 'warning', text: 'blocked by hook' })

    expect(markers(s.id).map((m) => m.text)).toEqual([warning, 'blocked by hook', 'blocked by hook'])
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(3)
  })

  it('a model switch the tool made is recorded without a restart and sent as the host snapshot', async () => {
    const { p, s, h } = await start('opus')
    h.emitEvent({
      type: 'settings_changed', sessionId: s.id, model: 'claude-sonnet-4-6', effort: null, verbosity: null, serviceTier: null, by: 'tool',
    })

    // The process already runs with it: not swapped
    expect(adapter.last).toBe(h)
    expect(h.disposed).toBe(false)
    const listed = ((await rpc('sessions.list', {})) as SessionInfo[]).find((x) => x.id === s.id)!
    expect(listed.model).toBe('claude-sonnet-4-6')
    expect(events.filter((e) => e.type === 'settings_changed')).toEqual([
      { type: 'settings_changed', sessionId: s.id, model: 'claude-sonnet-4-6', effort: null, verbosity: null, serviceTier: null, by: 'tool' },
    ])
    // Not a choice the person made — the project's remembered default stays as it was
    const defaults = ((await rpc('projects.list', {})) as { id: string; defaultModels: Record<string, unknown> }[]).find((x) => x.id === p.id)
    expect(defaults?.defaultModels.claude).toBeUndefined()
    // Saving the same model afterwards is not a change to the running process either
    await rpc('agents.updateSettings', { sessionId: s.id, model: 'claude-sonnet-4-6' })
    expect(adapter.last).toBe(h)
  })

  it("a switch the tool made does not overwrite a choice the person saved mid-turn; the turn's end applies theirs", async () => {
    const { s, h } = await start('opus')
    await rpc('agents.send', { sessionId: s.id, text: 'work' })
    await rpc('agents.updateSettings', { sessionId: s.id, model: 'haiku' })
    // The person's own save was announced (#659); the tool's switch after it is not, since nothing was recorded
    expect(events.filter((e) => e.type === 'settings_changed')).toMatchObject([{ model: 'haiku', person: true }])
    events.length = 0
    h.emitEvent({
      type: 'settings_changed', sessionId: s.id, model: 'claude-sonnet-4-6', effort: null, verbosity: null, serviceTier: null, by: 'tool',
    })
    expect(((await rpc('sessions.list', {})) as SessionInfo[]).find((x) => x.id === s.id)!.model).toBe('haiku')
    expect(events.some((e) => e.type === 'settings_changed')).toBe(false)

    h.finishTurn()
    await vi.waitFor(() => expect(adapter.last).not.toBe(h))
    expect(adapter.lastOpts?.model).toBe('haiku')
  })
})
