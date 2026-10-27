import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { readTextFileFor } from '../acp/session.js'
import { FakeAcpPeer, type PeerScript } from '../acp/fake-peer.test-helpers.js'
import { redactLines, startToolProcess } from '../core/tool-process.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { agyStderrLine, readAgyCall } from './shape.js'
import { driven, fakeInstall, fakeSignIn, readsWorld, sessionOpts, tempData, tokenPath } from './agent-files.test-helpers.js'

/**
 * What the spike could not make the agent send on cue (docs/plans/antigravity-adapter.md §5, §6): a question to the person
 * (`interaction_*`, read in its binary), reads through Centralu, and the stderr kept out of messages. The frames here are
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
  fakeInstall(t.home)
  fakeSignIn(t.home)
  const peers: FakeAcpPeer[] = []
  const adapter = new AntigravityAdapter(antigravityProfile({ dataDir: t.dir, platform: 'darwin', arch: 'arm64' }), () => {
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

describe('reads through Centralu (`fs/read_text_file`)', () => {
  function folders() {
    const f = readsWorld()
    data.push(f)
    return f
  }

  it('reads a file in the project folder, by lines when asked', async () => {
    const f = folders()
    await expect(readTextFileFor(f.project, [f.agent], { sessionId: 's', path: f.notes })).resolves.toEqual({ content: 'one\ntwo\nthree\n' })
    await expect(readTextFileFor(f.project, [f.agent], { sessionId: 's', path: f.notes, line: 2, limit: 1 })).resolves.toEqual({ content: 'two' })
  })

  it("refuses the agent's own home (its token), even inside the project, and anything outside the project", async () => {
    const f = folders()
    await expect(readTextFileFor(f.project, [f.agent], { sessionId: 's', path: f.token })).rejects.toThrow(/agent's own data/)
    await expect(readTextFileFor(f.project, [f.agent], { sessionId: 's', path: f.outside })).rejects.toThrow(/outside it/)
    await expect(readTextFileFor(f.project, [f.agent], { sessionId: 's', path: 'notes.txt' })).rejects.toThrow(/absolute/)
  })

  it('refuses a link in the project that points at the token', async () => {
    const f = folders()
    const link = f.link()
    // Windows without the right to make links: the real-path rule is the one the test above holds
    if (link === null) return
    await expect(readTextFileFor(f.project, [f.agent], { sessionId: 's', path: link })).rejects.toThrow(/agent's own data/)
  })

  it("is answered for the agent: the session's folder only, and never Centralu's Antigravity folder", async () => {
    const f = folders()
    const w = world(base)
    const handle = await w.adapter.createSession(sessionOpts('agy-r', 'normal', { cwd: f.project }), w.emit)
    const inside = await w.peers[0]!.ask('fs/read_text_file', { sessionId: SID, path: f.notes })
    expect(inside).toEqual({ content: 'one\ntwo\nthree\n' })
    const refused = await w.peers[0]!.ask('fs/read_text_file', { sessionId: SID, path: tokenPath(w.home) })
    expect(refused).toMatchObject({ code: -32002 })
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
