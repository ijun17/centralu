import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { readTextFileFor } from '../acp/session.js'
import { FakeAcpPeer, type PeerScript } from '../acp/fake-peer.test-helpers.js'
import { logToolStderr, redactLines, startToolProcess } from '../core/tool-process.js'
import { agyHome, reachesAgentFolder } from './agent-files.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { AGY_DISABLED_TOOLS, agyStderrLine, readAgyCall } from './shape.js'
import { driven, fakeInstall, fakeSignIn, folder, link, pathFrom, pathIn, readsWorld, sessionOpts, tempData, tokenPath, write } from './agent-files.test-helpers.js'

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

describe("Antigravity's subagents", () => {
  it('are switched off at the server by the names it accepts', () => {
    // The server's BuiltinTools values (1.4.3): any other name is dropped with "Unknown tool name in disabledTools"
    const accepted = ['list_directory', 'search_directory', 'find_file', 'view_file', 'create_file', 'edit_file', 'run_command', 'ask_question', 'invoke_subagent', 'run_workflow', 'generate_image', 'search_web', 'read_url_content', 'schedule', 'finish']
    for (const name of AGY_DISABLED_TOOLS) expect(accepted, name).toContain(name)
    expect(AGY_DISABLED_TOOLS).toEqual(expect.arrayContaining(['view_file', 'search_directory', 'invoke_subagent', 'run_workflow']))
  })

  for (const preset of ['safe', 'normal', 'edits', 'auto'] as const) {
    it(`under ${preset}, and with a saved rule for it, a subagent request is declined without a card`, async () => {
      const w = world(base, preset)
      const handle = await w.adapter.createSession(sessionOpts('agy-sub', preset), w.emit)
      handle.applyRules?.(['invoke_subagent', 'other', '*'])
      handle.send('go')
      await w.peers[0]!.next((m) => m.method === 'session/prompt')
      expect(await w.peers[0]!.ask('session/request_permission', SUBAGENT)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
      expect(w.events.some((e) => e.type === 'approval_request')).toBe(false)
      await handle.dispose()
    })
  }
})

/** An edit or read request as the agent asks for one under Auto (re-review of #1680: `replace_file_content`, kind `edit`) */
const touching = (id: string, title: string, kind: string, rawInput: Record<string, unknown>) => ({
  sessionId: SID,
  toolCall: { toolCallId: id, title, kind, status: 'pending', rawInput },
  options: [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ],
})
const NO = { outcome: { outcome: 'selected', optionId: 'reject_once' } }
const YES = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

describe("the agent's own folder, kept from its tools", () => {
  for (const preset of ['safe', 'normal', 'edits', 'auto'] as const) {
    it(`under ${preset}, and with a saved rule for it, an edit or read of a file there is declined without a card`, async () => {
      const w = world(base, preset)
      const own = pathIn(w.home.geminiHome, 'antigravity-acp')
      folder(own)
      write(pathIn(own, 'settings.json'), '{}')
      const project = pathIn(w.home.root, '..', '..', 'project')
      folder(project)
      const handle = await w.adapter.createSession(sessionOpts('agy-own', preset, { cwd: project }), w.emit)
      handle.applyRules?.(['replace_file_content', 'edit', '*'])
      handle.send('go')
      const peer = w.peers[0]!
      await peer.next((m) => m.method === 'session/prompt')
      const asks = [
        // As measured: the edit tool on a file in the token's folder
        touching('own-1', 'Run replace_file_content?', 'edit', { TargetFile: pathIn(own, 'settings.json'), TargetContent: 'a', ReplacementContent: 'b' }),
        // The token itself, spelled in another case (one file on macOS and Windows), and a file not there yet
        touching('own-2', 'Run write_to_file?', 'edit', { TargetFile: tokenPath(w.home).toUpperCase(), CodeContent: 'x' }),
        touching('own-3', 'Run write_to_file?', 'edit', { TargetFile: pathIn(own, 'new', 'deeper.txt'), CodeContent: 'x' }),
        // A read by address, the MCP config beside it, and a path climbing out of the session's folder
        touching('own-4', 'Run read_url_content?', 'fetch', { Url: `file://${tokenPath(w.home)}` }),
        touching('own-5', 'Run write_to_file?', 'edit', { TargetFile: pathIn(w.home.geminiHome, 'config', 'mcp_config.json'), CodeContent: '{}' }),
        touching('own-6', 'Run replace_file_content?', 'edit', { TargetFile: pathFrom(project, pathIn(own, 'settings.json')) }),
        // Another conversation's plan folder
        touching('own-7', 'Run create_file?', 'edit', { TargetFile: pathIn(own, 'brain', 'another-session', 'plan.md'), CodeContent: '# Plan' }),
      ]
      for (const ask of asks) expect(await peer.ask('session/request_permission', ask), ask.toolCall.toolCallId).toEqual(NO)
      expect(w.events.some((e) => e.type === 'approval_request')).toBe(false)
      await handle.dispose()
    })
  }

  it('folds case where no part of the path exists to tell it (macOS and Windows take any case for one file)', async () => {
    const home = agyHome(pathIn('/', 'no-such-cc-data'), '1.4.3')
    const token = pathIn(home.geminiHome, 'antigravity-acp', 'acp_token.json')
    await expect(reachesAgentFolder(home, { rawInput: { TargetFile: token.toUpperCase() } }, SID, '/work')).resolves.toBe(true)
    await expect(reachesAgentFolder(home, { rawInput: { TargetFile: pathIn('/', 'no-such-cc-data', 'project', 'a.txt') } }, SID, '/work')).resolves.toBe(false)
  })

  it("lets this conversation's plan through as any edit, but not a link in its folder to the token", async () => {
    const w = world(base, 'auto')
    const plans = pathIn(w.home.geminiHome, 'antigravity-acp', 'brain', SID)
    folder(plans)
    fakeSignIn(w.home)
    const handle = await w.adapter.createSession(sessionOpts('agy-plan', 'auto'), w.emit)
    handle.send('go')
    const peer = w.peers[0]!
    await peer.next((m) => m.method === 'session/prompt')
    // As `/plan` asked (measured on 1.4.3): create_file on brain/<session>/plan.md
    expect(await peer.ask('session/request_permission', touching('plan-1', 'Run create_file?', 'edit', { TargetFile: pathIn(plans, 'plan.md'), CodeContent: '# Plan' }))).toEqual(YES)
    if (link(tokenPath(w.home), pathIn(plans, 'notes.md'))) {
      expect(await peer.ask('session/request_permission', touching('plan-2', 'Run replace_file_content?', 'edit', { TargetFile: pathIn(plans, 'notes.md') }))).toEqual(NO)
    }
    await handle.dispose()
  })
})
