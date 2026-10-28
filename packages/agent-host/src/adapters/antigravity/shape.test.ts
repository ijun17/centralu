import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { FakeAcpPeer, type PeerScript } from '../acp/fake-peer.test-helpers.js'
import { logToolStderr, redactLines, startToolProcess } from '../core/tool-process.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { agyStderrLine, readAgyCall } from './shape.js'
import { driven, fakeInstall, HOST_TEST_ARCHIVE, HOST_TEST_PLATFORM, fakeSignIn, pathIn, sessionOpts, tempData, tokenPath } from './agent-files.test-helpers.js'

/**
 * What the spike could not make the agent send on cue (docs/plans/antigravity-adapter.md §5, §6): a question to the person
 * (`interaction_*`, read in its binary), what Centralu offers at the start, and the stderr kept out of messages. The frames here are
 * written by hand in the shapes the binary and the recordings show, and say so.
 */

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

const SID = 'ses-q'
const INIT = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, agentInfo: { name: 'antigravity-acp', version: '1.4.3' } }

function world(script: PeerScript, preset: PermissionPreset = 'normal') {
  const t = tempData()
  data.push(t)
  fakeInstall(t.home, HOST_TEST_ARCHIVE)
  fakeSignIn(t.home)
  const peers: FakeAcpPeer[] = []
  const adapter = new AntigravityAdapter(antigravityProfile({ dataDir: t.dir, platform: HOST_TEST_PLATFORM, arch: 'x64' }), () => {
    const p = new FakeAcpPeer(script)
    peers.push(p)
    return p
  })
  const d = driven()
  return { adapter, peers, preset, home: t.home, ...d }
}

const base: PeerScript = (method) => {
  if (method === 'initialize') return { result: INIT }
  if (method === 'session/new') return { result: { sessionId: SID } }
  if (method === 'session/prompt') return { hold: true }
  return { result: null }
}

/** A question as the agent's binary builds one: `interaction_<hex>`, no kind, empty input, one option per answer */
const QUESTION = {
  sessionId: SID,
  toolCall: { toolCallId: 'interaction_0f3a', title: 'Which file should I change?', rawInput: {} },
  options: [
    { optionId: 'opt-0', name: 'a.txt', kind: 'allow_once' },
    { optionId: 'opt-1', name: 'b.txt', kind: 'allow_once' },
    { optionId: 'deny', name: 'Neither', kind: 'reject_once' },
  ],
}

describe("Antigravity's questions", () => {
  for (const preset of ['normal', 'auto'] as const) {
    it(`under ${preset}, an interaction_* request is a question card, never answered by itself, and the answer picks its option`, async () => {
      const w = world(base, preset)
      const handle = await w.adapter.createSession(sessionOpts('agy-q', preset), w.emit)
      handle.send('go')
      await w.peers[0]!.next((m) => m.method === 'session/prompt')
      const answered = w.peers[0]!.ask('session/request_permission', QUESTION)
      const q = (await w.event((e) => e.type === 'question_request')) as Extract<NormalizedEvent, { type: 'question_request' }>
      expect(q.questions).toEqual([{ question: 'Which file should I change?', header: '', multiSelect: false, options: ['a.txt', 'b.txt', 'Neither'].map((label) => ({ label, description: '' })) }])
      expect(w.events.some((e) => e.type === 'approval_request')).toBe(false)
      expect(handle.answerQuestion!(q.requestId, [{ question: q.questions[0]!.question, answers: ['b.txt'] }])).toBe(true)
      expect(await answered).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } })
      expect(w.events.some((e) => e.type === 'question_resolved' && e.requestId === q.requestId)).toBe(true)
      await handle.dispose()
    })
  }

  it('an answer that is none of its options, and a Stop, are answered cancelled (the agent takes it as no answer)', async () => {
    const w = world(base)
    const handle = await w.adapter.createSession(sessionOpts('agy-q2'), w.emit)
    handle.send('go')
    await w.peers[0]!.next((m) => m.method === 'session/prompt')
    const first = w.peers[0]!.ask('session/request_permission', QUESTION)
    const q = (await w.event((e) => e.type === 'question_request')) as Extract<NormalizedEvent, { type: 'question_request' }>
    handle.answerQuestion!(q.requestId, [{ question: q.questions[0]!.question, answers: ['something typed'] }])
    expect(await first).toEqual({ outcome: { outcome: 'cancelled' } })
    const second = w.peers[0]!.ask('session/request_permission', { ...QUESTION, toolCall: { ...QUESTION.toolCall, toolCallId: 'interaction_0f3b' } })
    await w.event((e) => e.type === 'question_request' && e.requestId !== q.requestId)
    handle.interrupt()
    expect(await second).toEqual({ outcome: { outcome: 'cancelled' } })
    await handle.dispose()
  })
})

describe('what Centralu offers the agent at the start', () => {
  it('advertises no client reads, sends no tool filter, and answers a read request as not offered', async () => {
    const w = world(base)
    const handle = await w.adapter.createSession(sessionOpts('agy-r'), w.emit)
    const peer = w.peers[0]!
    const init = (await peer.next((m) => m.method === 'initialize')) as { params: { clientCapabilities: unknown } }
    expect(init.params.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false } })
    const created = (await peer.next((m) => m.method === 'session/new')) as { params: Record<string, unknown> }
    expect(created.params._meta).toBeUndefined()
    // The agent reads with its own viewer as shipped; a read sent here anyway is not served
    expect(await peer.ask('fs/read_text_file', { sessionId: SID, path: tokenPath(w.home) })).toMatchObject({ code: -32601 })
    await handle.dispose()
  })
})

describe("the agent's stderr", () => {
  it('reaches a crash message without its addresses, emails or token lines', async () => {
    const peer = new FakeAcpPeer(() => ({ hold: true }))
    const proc = startToolProcess({ command: 'agy', args: [], env: {} }, { spawn: () => peer, stderrLine: agyStderrLine })
    peer.stderr.write(['Starting AGY ACP Server...', "loadCodeAssist response: {'upgradeSubscriptionUri': 'https://accounts.google.com/AccountChooser?Email=someone@example.com'}", 'Agent session ended'].join('\n'))
    await new Promise((r) => setImmediate(r))
    expect(proc.stderrTail!()).toBe('Starting AGY ACP Server...\nAgent session ended')
    expect(redactLines('a\nb', (l) => (l === 'a' ? null : l))).toBe('b')
  })
})

describe("the agent's field names", () => {
  it('reads a replayed rawInput (a JSON string, session/load) as the object it says', () => {
    const read = readAgyCall({ toolCallId: 'c', title: undefined, kind: 'execute', status: 'completed', content: undefined, locations: undefined, rawInput: '{"CommandLine":"echo hi","Cwd":"/p"}' })
    expect(read.rawInput).toMatchObject({ command: 'echo hi', cwd: '/p' })
  })
})

describe("an allowed edit's run", () => {
  const edit = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    sessionUpdate: id.includes(':') || status === 'pending' ? 'tool_call' : 'tool_call_update',
    toolCallId: id,
    kind: 'edit',
    status,
    locations: [{ path: '/work/notes.txt' }],
    ...extra,
  })
  const asked = (id: string) => ({
    sessionId: SID,
    toolCall: { toolCallId: id, kind: 'edit', status: 'pending', title: 'Run create_file?', rawInput: { TargetFile: '/work/notes.txt', CodeContent: 'x' } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  })

  it('is folded into its own asked call, even after an earlier allowed edit of that file ended with no run', async () => {
    const w = world(base, 'auto')
    const handle = await w.adapter.createSession(sessionOpts('agy-e', 'auto'), w.emit)
    handle.send('go')
    const peer = w.peers[0]!
    await peer.next((m) => m.method === 'session/prompt')
    // The first edit is allowed (Auto, no card), then ends failed with no run of its own
    peer.update(SID, edit('ed-1', 'pending', { rawInput: { TargetFile: '/work/notes.txt' } }))
    await peer.ask('session/request_permission', asked('ed-1'))
    peer.update(SID, edit('ed-1', 'failed', { rawOutput: 'Tool call was approved but never executed.' }))
    // A second edit of the same file is allowed, and runs under a new id
    peer.update(SID, edit('ed-2', 'pending', { rawInput: { TargetFile: '/work/notes.txt' } }))
    await peer.ask('session/request_permission', asked('ed-2'))
    peer.update(SID, { ...edit(`${SID}:3`, 'in_progress', { rawInput: { file_path: '/work/notes.txt' } }), title: 'Running edit_file' })
    peer.update(SID, { sessionUpdate: 'tool_call_update', toolCallId: `${SID}:3`, status: 'completed', rawOutput: 'Edited' })
    const second = (await w.event((e) => e.type === 'tool_result' && e.callId === 'ed-2')) as Extract<NormalizedEvent, { type: 'tool_result' }>
    expect(second.ok).toBe(true)
    expect(w.events.filter((e) => e.type === 'tool_call').map((e) => (e as { callId: string }).callId)).toEqual(['ed-1', 'ed-2'])
    await handle.dispose()
  })
  it('never takes another edit announced before the run for that run', async () => {
    const w = world(base, 'auto')
    const handle = await w.adapter.createSession(sessionOpts('agy-e2', 'auto'), w.emit)
    handle.send('go')
    const peer = w.peers[0]!
    await peer.next((m) => m.method === 'session/prompt')
    peer.update(SID, edit('ed-1', 'pending', { rawInput: { TargetFile: '/work/notes.txt' } }))
    await peer.ask('session/request_permission', asked('ed-1'))
    // A second edit of the same file is announced (pending) before the first one's run comes
    peer.update(SID, edit('ed-2', 'pending', { rawInput: { TargetFile: '/work/notes.txt' } }))
    peer.update(SID, { ...edit(`${SID}:3`, 'in_progress', { rawInput: { file_path: '/work/notes.txt' } }), title: 'Running edit_file' })
    peer.update(SID, { sessionUpdate: 'tool_call_update', toolCallId: `${SID}:3`, status: 'completed', rawOutput: 'Edited' })
    const first = (await w.event((e) => e.type === 'tool_result' && e.callId === 'ed-1')) as Extract<NormalizedEvent, { type: 'tool_result' }>
    expect(first.ok).toBe(true)
    expect(w.events.filter((e) => e.type === 'tool_call').map((e) => (e as { callId: string }).callId)).toEqual(['ed-1', 'ed-2'])
    expect(w.events.some((e) => e.type === 'tool_result' && e.callId === 'ed-2')).toBe(false)
    await handle.dispose()
  })
})

describe('the log of a split stderr line', () => {
  it('judges a line whole, so half an address never reaches host.log', async () => {
    const said: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void said.push(args.join(' '))
    try {
      const peer = new FakeAcpPeer(() => ({ hold: true }))
      logToolStderr(peer, 'agy', agyStderrLine)
      peer.stderr.write('Open the following link: https://accounts.goo')
      peer.stderr.write('gle.com/o/oauth2/v2/auth?state=secretpart\nplain line\n')
      await new Promise((r) => setImmediate(r))
    } finally {
      console.error = original
    }
    expect(said).toEqual(['[agy] plain line'])
  })
})

/** The request the review recorded after asking for a subagent (the WS frame's `raw`, the project path made neutral) */
const SUBAGENT = {
  sessionId: SID,
  toolCall: {
    toolCallId: 'call-sub-1',
    title: 'Run invoke_subagent?',
    kind: 'other',
    rawInput: { Subagents: [{ Model: 'inherit', Prompt: 'Please open the file at `/work/notes.txt` and read its first line.', Role: 'Canary Note Reader', TypeName: 'research', Workspace: 'inherit' }] },
  },
  options: [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ],
}

/** An edit request as the agent asks for one (re-review of #1680: `replace_file_content`, kind `edit`) */
const touching = (id: string, title: string, kind: string, rawInput: Record<string, unknown>) => ({
  sessionId: SID,
  toolCall: { toolCallId: id, title, kind, status: 'pending', rawInput },
  options: [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ],
})
const YES = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

/**
 * Owner decision on #59 (2026-10-28): the agent runs as shipped. A subagent, and a request naming a file in the agent's own
 * folder, are answered as any other request: under Auto without a card, under the other presets with one
 */
describe("requests Centralu once refused (subagents, the agent's own folder)", () => {
  const asks = (home: ReturnType<typeof world>['home']) => [
    SUBAGENT,
    touching('own-1', 'Run replace_file_content?', 'edit', { TargetFile: pathIn(home.geminiHome, 'antigravity-acp', 'settings.json'), TargetContent: 'a', ReplacementContent: 'b' }),
    touching('own-2', 'Run write_to_file?', 'edit', { TargetFile: tokenPath(home), CodeContent: 'x' }),
  ]

  it('under auto, each is allowed without a card', async () => {
    const w = world(base, 'auto')
    const handle = await w.adapter.createSession(sessionOpts('agy-sub', 'auto'), w.emit)
    handle.send('go')
    const peer = w.peers[0]!
    await peer.next((m) => m.method === 'session/prompt')
    for (const ask of asks(w.home)) expect(await peer.ask('session/request_permission', ask), ask.toolCall.toolCallId).toEqual(YES)
    expect(w.events.some((e) => e.type === 'approval_request')).toBe(false)
    await handle.dispose()
  })

  for (const preset of ['safe', 'normal', 'edits'] as const) {
    it(`under ${preset}, each is a card, and the person's Allow answers it`, async () => {
      const w = world(base, preset)
      const handle = await w.adapter.createSession(sessionOpts('agy-sub2', preset), w.emit)
      handle.send('go')
      const peer = w.peers[0]!
      await peer.next((m) => m.method === 'session/prompt')
      const answeredCards = new Set<string>()
      for (const ask of asks(w.home)) {
        const answered = peer.ask('session/request_permission', ask)
        const card = (await w.event((e) => e.type === 'approval_request' && !answeredCards.has(e.requestId))) as Extract<NormalizedEvent, { type: 'approval_request' }>
        answeredCards.add(card.requestId)
        expect(handle.respondApproval(card.requestId, 'allow')).toBe(true)
        expect(await answered, ask.toolCall.toolCallId).toEqual(YES)
      }
      await handle.dispose()
    })
  }
})
