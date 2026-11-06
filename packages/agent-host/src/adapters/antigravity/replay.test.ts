import { afterEach, describe, expect, it } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { ORCHESTRATOR_MCP_NAME } from '../../apps/contract.js'
import type { AgentProcess, CreateSessionOpts } from '../contract.js'
import { fakeCentraluTools } from '../frames/fakes.test-helpers.js'
import { callOrder, of, replaySpawner, type Recording } from '../frames/replay.test-helpers.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { agyRecording, driven, fakeInstall, HOST_TEST_ARCHIVE, HOST_TEST_PLATFORM, fakeSignIn, sentFrames, sessionOpts, tempData, turnEnded } from './agent-files.test-helpers.js'

/**
 * Antigravity's agent (1.4.3) against the spike's recorded frames (docs/plans/antigravity-adapter.md §10): the adapter is
 * the generic ACP one with Antigravity's profile, started on the recording instead of the binary. The recordings were made
 * by the spike's own client, so what the adapter sends is matched by method and by its answers to the agent's requests
 * (`jsonRpcCodec`), not by every parameter. Each test waits for events, never for time.
 *
 * A second set, of 1.5.0 (the installed `agy acp`, the next release after the pinned one), was recorded through this adapter by
 * `scripts/frames-record.mts antigravity`; its tests say what the adapter makes of the frames 1.5.0 sends, which is not yet the
 * release Centralu runs (#2048). The 1.4.3 ones stay: they are the pinned agent's.
 */

const recording = agyRecording
const recording15 = (name: string) => agyRecording(name, '1.5.0')

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

function world(rec: Recording, opts: { signedIn?: boolean } = {}) {
  const temp = tempData()
  data.push(temp)
  fakeInstall(temp.home, HOST_TEST_ARCHIVE)
  if (opts.signedIn !== false) fakeSignIn(temp.home)
  const { spawn, state, peers } = replaySpawner(rec)
  const sent: Record<string, unknown>[][] = []
  const notes: number[] = []
  const spawnNoted = (spec: Parameters<typeof spawn>[0]): AgentProcess => {
    const p = spawn(spec)
    sent.push(sentFrames(p))
    Object.assign(p, { noteTree: async () => void notes.push(Date.now()) })
    return p
  }
  const profile = antigravityProfile({ dataDir: temp.dir, platform: HOST_TEST_PLATFORM, arch: 'x64' })
  const adapter = new AntigravityAdapter(profile, spawnNoted)
  return { adapter, profile, state, peers, sent, notes, ...driven() }
}

/** One turn: every card answered `decide`, until the turn ends */
async function turn(w: ReturnType<typeof world>, handle: Awaited<ReturnType<AntigravityAdapter['createSession']>>, text: string, decide: 'allow' | 'deny') {
  const from = w.events.length
  handle.send(text)
  const answered = new Set<string>()
  for (;;) {
    const e = await w.event((x) => w.events.indexOf(x) >= from && ((x.type === 'approval_request' && !answered.has(x.requestId)) || turnEnded(x)))
    if (e.type !== 'approval_request') return
    answered.add(e.requestId)
    handle.respondApproval(e.requestId, decide)
  }
}

async function open(w: ReturnType<typeof world>, preset: PermissionPreset = 'normal', resume?: string, more: Partial<CreateSessionOpts> = {}) {
  return w.adapter.createSession(sessionOpts('agy-replay', preset, { ...(resume ? { resumeExternalId: resume } : {}), ...more }), w.emit)
}

describe('Antigravity in the registry', () => {
  it('is registered for everyone: the screens for its install and sign-in exist (#59)', async () => {
    const { createAdapters } = await import('../registry.js')
    expect(createAdapters().get('antigravity')).toBeInstanceOf(AntigravityAdapter)
  })
})

describe('Antigravity 1.4.3, replayed', () => {
  it('permissions: a command and an edit asked and allowed; the edit card ends as the edit did, under the id that was asked', async () => {
    const w = world(recording('permissions'))
    const handle = await open(w)
    await turn(w, handle, 'Do these three steps', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    expect(callOrder(w.events)).toEqual([])

    const cards = of(w.events, 'approval_request')
    expect(cards.map((c) => c.detail.kind)).toEqual(['command', 'file_edit'])
    // The shell's input is `CommandLine`/`Cwd`, not `command` (spike §5): the card names the agent's folder, not the session's (`/work`)
    expect(cards[0]!.detail).toMatchObject({ kind: 'command', command: 'echo hello-from-shell', cwd: '<cwd>' })
    const results = new Map(of(w.events, 'tool_result').map((r) => [r.callId, r]))
    const shell = of(w.events, 'tool_call').find((c) => c.summary.tool === 'Bash')!
    // `rawOutput.combinedOutput` is the command's output
    expect(results.get(shell.callId)).toMatchObject({ ok: true })
    expect(JSON.stringify(results.get(shell.callId))).toContain('hello-from-shell')
    // The asked edit and its run (a new id, `<session>:3`) are one card that ends ok, not a failed one and a second call
    const edits = of(w.events, 'tool_call').filter((c) => c.summary.tool === 'Edit')
    expect(edits).toHaveLength(1)
    expect(results.get(edits[0]!.callId)).toMatchObject({ ok: true })
    expect(of(w.events, 'tool_call')).toHaveLength(4)
    // A read the harness refused ends `completed`: accepted as the agent said it (its text says it was refused)
    const reads = of(w.events, 'tool_call').filter((c) => c.summary.tool === 'Read')
    expect(reads.map((r) => results.get(r.callId)?.ok)).toEqual([true, true])
    // The tree is noted while the command runs, so a Stop ends the command's own process group (spike §9)
    expect(w.notes.length).toBeGreaterThan(0)
    // The context window and the turn's tokens
    expect(of(w.events, 'context_update').at(-1)).toMatchObject({ window: 1_048_576, exactness: 'exact' })
    expect(of(w.events, 'usage_update').at(-1)?.tokens).toMatchObject({ inputTokens: 71032 })
  })

  it('permissions: the agent stays in its default mode, with no client reads offered and no tool filter sent', async () => {
    const w = world(recording('permissions'))
    const handle = await open(w)
    await turn(w, handle, 'Do these three steps', 'allow')
    await handle.dispose()
    const frames = w.sent[0]!
    const methods = frames.flatMap((f) => (typeof f.method === 'string' ? [f.method] : []))
    expect(methods).not.toContain('session/set_mode')
    expect(methods).not.toContain('session/set_config_option')
    const init = frames.find((f) => f.method === 'initialize') as { params: { clientCapabilities: { fs: unknown; terminal: unknown } } }
    expect(init.params.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false })
    // The agent runs as shipped (owner decision on #59, 2026-10-28): no `_meta` on session/new, so no built-in tool is switched off
    const created = frames.find((f) => f.method === 'session/new') as { params: Record<string, unknown> }
    expect(created.params._meta).toBeUndefined()
    // Every answer is Allow once: `allow_always` (which the agent would keep as its own rule) is never sent
    const answers = frames.filter((f) => f.method === undefined).map((f) => JSON.stringify(f.result))
    expect(answers.every((a) => a.includes('"optionId":"allow"'))).toBe(true)
  })

  it('deny: a denied command ends not ok, and the turn goes on to its end', async () => {
    const w = world(recording('deny'))
    const handle = await open(w)
    await turn(w, handle, 'Read the file', 'allow')
    await turn(w, handle, 'Run echo answer-deny', 'deny')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    const denied = of(w.events, 'tool_call').find((c) => c.summary.tool === 'Bash')!
    expect(of(w.events, 'tool_result').find((r) => r.callId === denied.callId)).toMatchObject({ ok: false })
    expect(of(w.events, 'turn_complete')).toHaveLength(2)
  })

  it('load: a conversation opened again in a new process with session/load; its replay is not shown again', async () => {
    const w = world(recording('load'))
    const handle = await open(w, 'normal', 'ses-1')
    expect(handle.externalId).toBe('ses-1')
    const before = w.events.length
    expect(of(w.events, 'tool_call')).toHaveLength(0)
    await turn(w, handle, 'What exact shell command did you run earlier?', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    expect(of(w.events.slice(before), 'message_delta').length).toBeGreaterThan(0)
  })

  it("mcp: each MCP call is a card (another server's tools carry no Centralu rights)", async () => {
    const w = world(recording('mcp'))
    const handle = await open(w)
    await turn(w, handle, 'Call the MCP tools', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    expect(of(w.events, 'approval_request')).toHaveLength(2)
    expect(callOrder(w.events)).toEqual([])
  })

  it("mcp: a call to Centralu's own tools (`_meta.mcp.server`) is answered without a card, as Cursor's and OpenCode's are", async () => {
    // The recording with its stdio server named as Centralu's bridge: the frames are the agent's, the name is the bridge's
    const rec = recording('mcp')
    const renamed: Recording = JSON.parse(JSON.stringify(rec).replaceAll('"server":"spikestdio"', `"server":"${ORCHESTRATOR_MCP_NAME}"`)) as Recording
    const w = world(renamed)
    const handle = await open(w)
    await turn(w, handle, 'Call the MCP tools', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    const cards = of(w.events, 'approval_request')
    expect(cards).toHaveLength(1)
    expect(JSON.stringify(cards[0]!.detail)).toContain('spike_http_echo')
  })

  it('signed out: session/new refused (-32000) is a sign-in in Centralu, not "log in from a terminal", and the line turns signed out', async () => {
    const w = world(recording('signed-out'))
    const seen: string[] = []
    w.profile.agySetup.onChange((s) => seen.push(s.state))
    expect(w.profile.agySetup.current().state).toBe('ready')
    const err = await open(w).catch((e: unknown) => e as Error & { code?: string })
    expect(err).toMatchObject({ code: 'not_logged_in' })
    expect((err as Error).message).toMatch(/Sign in with Google/)
    expect((err as Error).message).not.toMatch(/terminal/)
    expect(w.profile.agySetup.current().state).toBe('signed_out')
    expect(seen).toEqual(['signed_out'])
    expect(w.state.problems).toEqual([])
  })
})

describe("Antigravity's agent as `agy acp` 1.5.0 runs it, replayed", () => {
  it('permissions: a command asked and allowed; an edit and a read outside the folder are made without a card (1.5.0 asks for neither); the shell result is the command’s output', async () => {
    const w = world(recording15('permissions'))
    const handle = await open(w)
    await turn(w, handle, 'Do these three steps', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    expect(callOrder(w.events)).toEqual([])

    // Only the command is asked about, under Normal (1.4.3 asked about the edit too, and refused the read outside the folder: #2048)
    const cards = of(w.events, 'approval_request')
    expect(cards.map((c) => c.detail.kind)).toEqual(['command'])
    // The shell's input is `CommandLine`: the card names the session's folder, not the agent's
    expect(cards[0]!.detail).toMatchObject({ kind: 'command', command: 'echo hello-from-shell', cwd: '/work' })
    const results = new Map(of(w.events, 'tool_result').map((r) => [r.callId, r]))
    const calls = of(w.events, 'tool_call')
    expect(calls.map((c) => c.summary.tool)).toEqual(['Bash', 'Read', 'Edit', 'Read'])
    expect(results.get(calls[0]!.callId)).toMatchObject({ ok: true, output: expect.stringContaining('hello-from-shell') })
    // The edit is one call that ends ok and marks its file; a read ends ok with the text the agent did not hand back
    expect(results.get(calls[2]!.callId)).toMatchObject({ ok: true })
    expect(of(w.events, 'files_touched')).toHaveLength(1)
    expect(calls.filter((c) => c.summary.tool === 'Read').map((c) => results.get(c.callId)?.ok)).toEqual([true, true])
    // The tree is noted while the command runs, so a Stop ends the command's own process group (spike §9)
    expect(w.notes.length).toBeGreaterThan(0)
    // The turn's tokens, with the cached part told apart
    expect(of(w.events, 'usage_update').at(-1)?.tokens).toMatchObject({ inputTokens: 16557, cacheReadTokens: 22293 })
    expect(of(w.events, 'agent_version').map((e) => e.version)).toEqual(['1.5.0'])
  })

  it('permissions: the agent stays in its default mode, with no client reads offered and no tool filter sent', async () => {
    const w = world(recording15('permissions'))
    const handle = await open(w)
    await turn(w, handle, 'Do these three steps', 'allow')
    await handle.dispose()
    const frames = w.sent[0]!
    const methods = frames.flatMap((f) => (typeof f.method === 'string' ? [f.method] : []))
    expect(methods).not.toContain('session/set_mode')
    expect(methods).not.toContain('session/set_config_option')
    const init = frames.find((f) => f.method === 'initialize') as { params: { clientCapabilities: { fs: unknown; terminal: unknown } } }
    expect(init.params.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false })
    // The agent runs as shipped (owner decision on #59, 2026-10-28): no `_meta` on session/new, so no built-in tool is switched off
    const created = frames.find((f) => f.method === 'session/new') as { params: Record<string, unknown> }
    expect(created.params._meta).toBeUndefined()
    // Every answer is Allow once: `allow_always` (which the agent would keep as its own rule) is never sent
    const answers = frames.filter((f) => f.method === undefined).map((f) => JSON.stringify(f.result))
    expect(answers.every((a) => a.includes('"optionId":"allow"'))).toBe(true)
  })

  it('deny: a denied command ends not ok, and the turn goes on to its end', async () => {
    const w = world(recording15('deny'))
    const handle = await open(w)
    await turn(w, handle, 'Read the file', 'allow')
    await turn(w, handle, 'Run echo answer-deny', 'deny')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    const denied = of(w.events, 'tool_call').find((c) => c.summary.tool === 'Bash')!
    expect(of(w.events, 'tool_result').find((r) => r.callId === denied.callId)).toMatchObject({ ok: false })
    expect(of(w.events, 'approval_resolved').map((r) => r.decision)).toEqual(['deny'])
    expect(of(w.events, 'turn_complete')).toHaveLength(2)
  })

  it('load: a conversation opened again in a new process with session/load; its replay is not shown again', async () => {
    const w = world(recording15('load'))
    const first = await open(w)
    await turn(w, first, 'Run echo hello-from-shell', 'allow')
    expect(first.externalId).toBe('ses-1')
    await first.dispose()
    const before = w.events.length
    const handle = await open(w, 'normal', first.externalId ?? undefined)
    expect(handle.externalId).toBe('ses-1')
    await turn(w, handle, 'What exact shell command did you run earlier?', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    expect(w.state.spawned).toBe(2)
    // The history the agent sent before its answer (the command and its result) is dropped: only the new turn's calls and words show
    expect(of(w.events.slice(before), 'tool_call')).toHaveLength(0)
    expect(of(w.events.slice(before), 'message_delta').map((e) => e.text).join('')).toContain('echo hello-from-shell')
    expect(of(w.events, 'turn_complete')).toHaveLength(2)
  })

  it("centralu-mail: Centralu's bridge named as the agent names it (`mcp_centralu_mail`) is a tool row, not a Centralu call, and its result is not in the frames (#2048)", async () => {
    const w = world(recording15('centralu-mail'))
    const handle = await open(w, 'normal', undefined, { orchestratorTools: fakeCentraluTools(), orchestratorBridge: { url: 'ws://127.0.0.1:0', token: 'replay' }, toolProfile: 'reader' })
    await turn(w, handle, 'Use the mail tool', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    const created = w.sent[0]!.find((f) => f.method === 'session/new') as { params: { mcpServers: { name: string }[] } }
    expect(created.params.mcpServers.map((m) => m.name)).toEqual([ORCHESTRATOR_MCP_NAME])
    const mail = of(w.events, 'tool_call').filter((c) => c.summary.tool === 'Run mcp_centralu_mail')
    expect(mail.map((c) => (c.input as { action?: string }).action)).toEqual(['inbox', 'send'])
    expect(of(w.events, 'approval_request')).toEqual([])
    for (const call of mail) expect(of(w.events, 'tool_result').find((r) => r.callId === call.callId)).toMatchObject({ ok: true, summary: '(Antigravity did not return the output)' })
  })

  it("centralu-agents: recall, read_session and start_agent are three tool rows named as the agent names them, each ended ok and asked about nothing (#2048)", async () => {
    const w = world(recording15('centralu-agents'))
    const handle = await open(w, 'normal', undefined, { orchestratorTools: fakeCentraluTools(), orchestratorBridge: { url: 'ws://127.0.0.1:0', token: 'replay' }, toolProfile: 'reader' })
    await turn(w, handle, 'Use the recall tool, then read_session, then start_agent', 'allow')
    await handle.dispose()
    expect(w.state.problems).toEqual([])
    expect(w.state.left()).toBe(0)
    expect(callOrder(w.events)).toEqual([])
    const calls = of(w.events, 'tool_call')
    expect(calls.map((c) => c.summary.tool)).toEqual(['Run mcp_centralu_recall', 'Run mcp_centralu_read_session', 'Run mcp_centralu_start_agent'])
    expect(of(w.events, 'tool_result').map((r) => r.ok)).toEqual([true, true, true])
    expect(of(w.events, 'approval_request')).toEqual([])
    expect(of(w.events, 'turn_complete')).toHaveLength(1)
  })

  it('signed out: session/new refused (-32000) with no detail is the same sign-in in Centralu', async () => {
    const w = world(recording15('signed-out'))
    const err = await open(w).catch((e: unknown) => e as Error & { code?: string })
    expect(err).toMatchObject({ code: 'not_logged_in' })
    expect((err as Error).message).toMatch(/Sign in with Google/)
    expect(w.profile.agySetup.current().state).toBe('signed_out')
    expect(w.state.problems).toEqual([])
  })
})
