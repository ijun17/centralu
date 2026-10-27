import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import type { AgentProcess } from '../contract.js'
import { replaySpawner, type Recording } from '../frames/replay.test-helpers.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { agyRecording, driven, fakeInstall, fakeSignIn, sentFrames, sessionOpts, tempData, turnEnded } from './agent-files.test-helpers.js'

/**
 * Antigravity's agent (1.4.3) against the spike's recorded frames (docs/plans/antigravity-adapter.md §10): the adapter is
 * the generic ACP one with Antigravity's profile, started on the recording instead of the binary. The recordings were made
 * by the spike's own client, so what the adapter sends is matched by method and by its answers to the agent's requests
 * (`jsonRpcCodec`), not by every parameter. Each test waits for events, never for time.
 */

const recording = agyRecording

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

function world(rec: Recording, opts: { signedIn?: boolean } = {}) {
  const temp = tempData()
  data.push(temp)
  fakeInstall(temp.home)
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
  const profile = antigravityProfile({ dataDir: temp.dir, platform: 'darwin', arch: 'arm64' })
  const adapter = new AntigravityAdapter(profile, spawnNoted)
  return { adapter, profile, state, peers, sent, notes, ...driven() }
}

/** Every call announced ends once, after it was announced */
function callOrder(events: readonly NormalizedEvent[]): string[] {
  const wrong: string[] = []
  const called = new Set<string>()
  const results = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'tool_call') {
      if (called.has(e.callId)) wrong.push(`${e.callId}: announced twice`)
      called.add(e.callId)
    }
    if (e.type !== 'tool_result') continue
    if (!called.has(e.callId)) wrong.push(`${e.callId}: a result before its call`)
    results.set(e.callId, (results.get(e.callId) ?? 0) + 1)
  }
  for (const id of called) if (results.get(id) !== 1) wrong.push(`${id}: ${results.get(id) ?? 0} results`)
  return wrong
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

async function open(w: ReturnType<typeof world>, preset: PermissionPreset = 'normal', resume?: string) {
  return w.adapter.createSession(sessionOpts('agy-replay', preset, resume ? { resumeExternalId: resume } : {}), w.emit)
}

const of = <T extends NormalizedEvent['type']>(events: readonly NormalizedEvent[], type: T) => events.filter((e): e is Extract<NormalizedEvent, { type: T }> => e.type === type)

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

  it('permissions: the agent stays in its default mode, offered reads only through Centralu, with its file viewers off', async () => {
    const w = world(recording('permissions'))
    const handle = await open(w)
    await turn(w, handle, 'Do these three steps', 'allow')
    await handle.dispose()
    const frames = w.sent[0]!
    const methods = frames.flatMap((f) => (typeof f.method === 'string' ? [f.method] : []))
    expect(methods).not.toContain('session/set_mode')
    expect(methods).not.toContain('session/set_config_option')
    const init = frames.find((f) => f.method === 'initialize') as { params: { clientCapabilities: { fs: unknown; terminal: unknown } } }
    expect(init.params.clientCapabilities).toMatchObject({ fs: { readTextFile: true, writeTextFile: false }, terminal: false })
    const created = frames.find((f) => f.method === 'session/new') as { params: { _meta?: { antigravity?: { disabledTools?: string[] } } } }
    expect(created.params._meta?.antigravity?.disabledTools).toEqual(expect.arrayContaining(['view_file', 'grep_search']))
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
