import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isInTurn, transition, type AdapterCapabilities, type Attachment, type NormalizedEvent, type SessionState } from '@cc/protocol'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { IMAGE_MAX_BYTES } from '../images.js'
import type { AgentProcess, CreateSessionOpts, ProcessSource } from '../contract.js'
import type { SessionApps } from '../contract/session-apps.js'
import { failureSentence, isNetworkFailure } from '../../sessions/error-kind.js'
import { AcpAdapter } from './adapter.js'
import { FakeAcpPeer, INIT_RESULT, type PeerScript } from './fake-peer.test-helpers.js'
import type { AcpProfile } from './profile.js'

/**
 * What the adapter does with frames a real tool cannot be made to send on cue (docs/plans/acp-adapter.md §10.3). Every
 * wait here is for an event or a frame, never for time.
 */

class FakeAdapter extends AcpAdapter {
  readonly tool = 'fake'
}

const profile: AcpProfile = {
  descriptor: { name: 'fake', label: 'Fake', mark: 'F', install: 'install it', login: 'log in' },
  capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true } as AdapterCapabilities,
  surface: undefined as never,
  launch: async () => ({ command: 'fake', args: ['acp'] }),
  detect: async () => ({ tool: 'fake', installed: true, loggedIn: true, detail: '' }),
  installedVersion: async () => '0.0.1',
}

const SID = 'ses-a'
const base: PeerScript = (method) => {
  if (method === 'initialize') return { result: INIT_RESULT }
  if (method === 'session/new') return { result: { sessionId: SID } }
  if (method === 'session/load') return { result: {} }
  if (method === 'session/prompt') return { hold: true }
  return { result: null }
}

function world(script: PeerScript = base, opts: Partial<CreateSessionOpts> = {}, withProfile: AcpProfile = profile) {
  const peers: FakeAcpPeer[] = []
  const spawn = () => {
    const p = new FakeAcpPeer(script)
    peers.push(p)
    return p
  }
  const events: NormalizedEvent[] = []
  const waiting: { pick(e: NormalizedEvent): boolean; resolve(e: NormalizedEvent): void }[] = []
  const emit = (e: NormalizedEvent) => {
    events.push(e)
    for (const w of [...waiting]) if (w.pick(e)) {
      waiting.splice(waiting.indexOf(w), 1)
      w.resolve(e)
    }
  }
  const event = (pick: (e: NormalizedEvent) => boolean) => {
    const seen = events.find(pick)
    return seen ? Promise.resolve(seen) : new Promise<NormalizedEvent>((resolve) => waiting.push({ pick, resolve }))
  }
  const adapter = new FakeAdapter(withProfile, spawn, 60_000)
  const start = () => adapter.createSession({ sessionId: 's1', cwd: '/work', permissionPreset: 'normal', projectTrusted: true, ...opts }, emit)
  return { peers, events, event, start, adapter }
}

const isPrompt = (m: Record<string, unknown>) => m.method === 'session/prompt'

const near = (n: number) => expect.closeTo(n, 6)

/** The cost each turn reports, one turn per running total the agent sends at its end */
async function turnCosts(w: ReturnType<typeof world>, s: Awaited<ReturnType<ReturnType<typeof world>['start']>>, totals: number[]) {
  const peer = w.peers.at(-1)!
  const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  for (const [i, total] of totals.entries()) {
    s.send(`turn ${i}`)
    await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(`turn ${i}`))
    peer.update(SID, { sessionUpdate: 'usage_update', used: 1_000, size: 200_000, cost: { amount: total, currency: 'USD' } })
    peer.release('session/prompt', { result: { stopReason: 'end_turn', usage } })
    await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'usage_update').length === i + 1)
  }
  return w.events.flatMap((e) => (e.type === 'usage_update' ? [e.tokens.costUsd] : []))
}

describe('the ACP session against a scripted agent', () => {
  it('never calls authenticate, and says the tool is not logged in', async () => {
    const w = world((method) => (method === 'session/new' ? { error: { code: -32000, message: 'Authentication required' } } : base(method, {}, null as never)))
    // In the tool line's words, as every tool says it
    await expect(w.start()).rejects.toMatchObject({ code: 'not_logged_in', message: 'Fake is not signed in. Run log in in a terminal.' })
    expect(w.peers[0]!.methods()).toEqual(['initialize', 'session/new'])
  })

  it('reports a conversation it cannot load, and does not start a new one in its place', async () => {
    const w = world((method) => (method === 'session/load' ? { error: { code: -32002, message: 'Session not found' } } : base(method, {}, null as never)), { resumeExternalId: 'gone' })
    await expect(w.start()).rejects.toThrow(/Session not found/)
    expect(w.peers[0]!.methods()).not.toContain('session/new')
  })

  /**
   * #1676, measured on Cursor 2026.10.22 (real CLI, Windows): it writes a conversation's store only once a model turn has run, so
   * a conversation opened but never answered (a turn refused for the account's usage included) is refused by `session/load` as
   * `-32602 Invalid params` (its data: Session ... not found) while the call's params are right, and `session/list` does not name it
   */
  describe('a load the agent refuses for a conversation it does not list', () => {
    const cursorLike = (listed: string[], nextCursor?: string): PeerScript => (method, params) => {
      if (method === 'initialize') return { result: { ...INIT_RESULT, agentCapabilities: { ...INIT_RESULT.agentCapabilities, sessionCapabilities: { list: {} } } } }
      if (method === 'session/load') return { error: { code: -32602, message: 'Invalid params' } }
      if (method === 'session/list') {
        const first = (params as { cursor?: string }).cursor === undefined
        return { result: { sessions: first ? listed.map((sessionId) => ({ sessionId, cwd: '/work' })) : [{ sessionId: 'ses-a', cwd: '/work' }], ...(first && nextCursor ? { nextCursor } : {}) } }
      }
      return base(method, params, null as never)
    }

    it('is a conversation gone, not an invalid call', async () => {
      const w = world(cursorLike(['ses-other']), { resumeExternalId: SID })
      await expect(w.start()).rejects.toMatchObject({ code: 'conversation_gone', message: expect.stringMatching(/no record of this conversation/) })
      expect(w.peers[0]!.methods()).toEqual(['initialize', 'session/load', 'session/list'])
    })

    it('stays the agent’s own error when it lists the conversation, on a later page too', async () => {
      const w = world(cursorLike(['ses-other'], 'next'), { resumeExternalId: SID })
      await expect(w.start()).rejects.toThrow(/Invalid params/)
      expect(w.peers[0]!.methods()).toEqual(['initialize', 'session/load', 'session/list', 'session/list'])
    })
  })

  it('sends the cancel again when the agent goes on with the turn, and the next turn is not taken for stopped', async () => {
    let cancels = 0
    const w = world((method) => {
      if (method === 'session/cancel') {
        cancels++
        // The first cancel came before the agent's turn had begun, and it was lost; the second one stops it
        if (cancels === 2) w.peers[0]!.release('session/prompt', { result: { stopReason: 'cancelled' } })
        return { result: null }
      }
      return base(method, {}, null as never)
    })
    const s = await w.start()
    s.send('first')
    await w.peers[0]!.next(isPrompt)
    s.interrupt()
    w.peers[0]!.update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still going' } })
    await w.event((e) => e.type === 'state_change' && e.state === 'waiting_input')
    expect(cancels).toBe(2)
    s.send('second')
    await w.peers[0]!.next((m) => isPrompt(m) && JSON.stringify(m).includes('second'))
    w.peers[0]!.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter((e) => e.type === 'state_change' && e.state === 'waiting_input').map((e) => e.type === 'state_change' && e.reason)).toEqual(['interrupted'])
  })

  it('takes a compaction from protocol frames only: its marker, its summary and a failed one', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: 'k1', status: 'in_progress' })
    peer.update(SID, { sessionUpdate: 'compaction_summary_chunk', compactionId: 'k1', content: { type: 'text', text: 'The summary.' } })
    peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: 'k1', status: 'completed' })
    peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: 'k2', status: 'failed', error: 'Not enough messages' })
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter((e) => e.type === 'compaction')).toMatchObject([
      { failed: false, reason: 'The summary.' },
      { failed: true, reason: 'Not enough messages' },
    ])
  })

  it('reads the context share from usage_update, and drops the zero a cancelled turn reads and a share above 1', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.update(SID, { sessionUpdate: 'usage_update', used: 0, size: 200_000 })
    peer.update(SID, { sessionUpdate: 'usage_update', used: 250_000, size: 200_000 })
    peer.update(SID, { sessionUpdate: 'usage_update', used: 11_176, size: 200_000 })
    peer.update(SID, { sessionUpdate: 'something_new', x: 1 })
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter((e) => e.type === 'context_update')).toEqual([{ type: 'context_update', sessionId: 's1', used: 11_176, window: 200_000, exactness: 'exact' }])
  })

  it('says a process that ended while idle went to sleep, and one that ended in a turn crashed', async () => {
    const idle = world()
    await idle.start()
    idle.peers[0]!.exit(0)
    expect(await idle.event((e) => e.type === 'session_live')).toMatchObject({ live: false, reason: 'asleep' })

    const busy = world()
    const s = await busy.start()
    s.send('go')
    await busy.peers[0]!.next(isPrompt)
    busy.peers[0]!.exit(1)
    expect(await busy.event((e) => e.type === 'error')).toMatchObject({ error: { code: 'adapter_crashed' } })
  })

  it("puts the process's last words after a marker, so they are not read as the turn's own failure", async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.stderr.write('connection reset: fetch failed\n')
    peer.exit(1)
    const { error } = (await w.event((e) => e.type === 'error')) as { error: { message: string } }
    expect(error.message).toMatch(/^Fake exited \(code 1\)\. stderr: connection reset/)
    expect(failureSentence(error.message)).toBe('Fake exited (code 1).')
    expect(isNetworkFailure(error.message)).toBe(false)
  })

  it('under Edits grants an edit inside the folder, and asks about a delete or a move there', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cc-acp-edits-')))
    try {
      const w = world(base, { cwd, permissionPreset: 'edits' })
      const s = await w.start()
      s.send('go')
      const peer = w.peers[0]!
      await peer.next(isPrompt)
      const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
      const ask = (kind: string, path: string) =>
        peer.ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: `call-${kind}`, kind, title: kind, locations: [{ path: join(cwd, path) }] } })
      expect(await ask('edit', 'a.ts')).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
      void ask('delete', 'b.ts')
      void ask('move', 'c.ts')
      // A command always asks under Edits: once its card is up, the two before it have had theirs, or were granted
      void ask('execute', 'd.ts')
      await w.event((e) => e.type === 'approval_request' && e.detail.kind === 'command')
      const cards = w.events.flatMap((e) => (e.type === 'approval_request' ? [e.detail.kind === 'file_edit' ? e.detail.path.slice(-4) : e.detail.kind] : []))
      expect(cards).toEqual(['b.ts', 'c.ts', 'command'])
      s.interrupt()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  // #2479 (session-core §2.11, Q7): a limit and a refusal end the turn as one retryable error, the same for every tool
  it.each([
    ['max_tokens', 'Fake stopped: the reply reached its length limit.'],
    ['max_turn_requests', 'Fake stopped: the turn reached its limit of steps.'],
    ['refusal', 'Fake refused to go on with this turn.'],
  ])('ends a turn the tool stopped with %s as a retryable error, not a notice and a completed turn', async (stopReason, message) => {
    const w = world()
    const s = await w.start()
    s.send('go')
    await w.peers[0]!.next(isPrompt)
    w.peers[0]!.release('session/prompt', { result: { stopReason } })
    const error = await w.event((e) => e.type === 'error')
    expect(error).toMatchObject({ error: { code: 'internal', message, retryable: true } })
    expect(w.events.some((e) => e.type === 'turn_complete' || e.type === 'notice')).toBe(false)
  })

  it('shows an edit approval as what the tool replaces and what it writes, and a new file as what it writes', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
    const content = (oldText: string | null) => [{ type: 'diff', path: '/p/a.ts', oldText, newText: 'new line\n' }]
    void peer.ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: 'c1', kind: 'edit', title: 'edit', content: content('old line\n') } })
    const edit = await w.event((e) => e.type === 'approval_request' && e.detail.kind === 'file_edit')
    expect(edit).toMatchObject({ detail: { diffPreview: '-old line\n+new line' } })
    void peer.ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: 'c2', kind: 'edit', title: 'edit', content: content(null) } })
    await w.event((e) => e.type === 'approval_request' && e.detail.kind === 'file_edit' && e.detail.diffPreview === '+new line')
    s.interrupt()
  })

  it('leaves an image over the size ceiling undrawn, with the reason', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'A'.repeat(11_500_000) } })
    expect(await w.event((e) => e.type === 'message_image')).toMatchObject({ data: '', note: expect.stringContaining('too large') })
    s.interrupt()
  })

  it('answers a question asked after Stop as cancelled, with no card, and sends the lost cancel again', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    s.interrupt()
    const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]
    const answer = await peer.ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: 'call-1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } })
    expect(answer).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(w.events.some((e) => e.type === 'approval_request')).toBe(false)
    expect(peer.methods().filter((m) => m === 'session/cancel')).toHaveLength(2)
  })

  it("fails an input whose turn was stopped, and completes one whose turn ended", async () => {
    const w = world()
    const s = await w.start()
    const peer = w.peers[0]!
    const seen: string[] = []
    const observer = (name: string) => ({ accepted: () => seen.push(`${name}:accepted`), complete: () => seen.push(`${name}:complete`), fail: (e: Error) => seen.push(`${name}:fail ${e.message}`) })
    const stopped = s.sendTracked!('stop me', observer('a'))
    await peer.next(isPrompt)
    s.interrupt()
    peer.release('session/prompt', { result: { stopReason: 'cancelled' } })
    await expect(stopped).rejects.toThrow(/stopped/)
    const done = s.sendTracked!('finish me', observer('b'))
    await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes('finish me'))
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await done
    expect(seen).toEqual(['a:accepted', 'a:fail The parent note was stopped before it finished', 'b:accepted', 'b:complete'])
  })

  it('logs a frame it cannot parse and goes on with the turn, rather than failing the running prompt', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.stdout.write('{"jsonrpc":"2.0","id":\n')
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete' || e.type === 'error')
    expect(w.events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('closes the calls a turn had open when the session is disposed mid-turn, so no card spins after a restart', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.update(SID, { sessionUpdate: 'tool_call', toolCallId: 'call-1', kind: 'execute', title: 'sleep 42', status: 'in_progress', rawInput: { command: 'sleep 42' } })
    await w.event((e) => e.type === 'tool_call')
    await s.dispose()
    expect(w.events.filter((e) => e.type === 'tool_result')).toMatchObject([{ callId: 'call-1', ok: false }])
  })

  /*
   * An ACP agent reaches apps through the bridge's `app` tool since #2231, and it sends no cancellation for one: the Stop and the
   * close stop the session's app calls at the host, a standing card included, as on Claude and Codex
   */
  it("the Stop cancels the session's app calls even with no turn running, and the close closes its apps", async () => {
    const seen: string[] = []
    const apps: SessionApps = { current: () => [], noteCall: () => {}, callEnded: () => {}, cancelAll: () => seen.push('cancelAll'), close: () => seen.push('close') }
    const w = world(base, { apps })
    const s = await w.start()
    s.interrupt()
    expect(seen).toEqual(['cancelAll'])
    await s.dispose()
    expect(seen).toEqual(['cancelAll', 'close'])
  })

  describe('a tool whose /compact leaves no protocol frame', () => {
    const inferring: AcpProfile = { ...profile, infersCompaction: true }
    const end = { result: { stopReason: 'end_turn' } }

    /** One ordinary turn read at `before`, then `text` sent as given, read at `after` */
    async function compactAfter(text: string, sendOpts: { compact?: boolean }, withProfile: AcpProfile, before = 9_889, after = 429) {
      const w = world(base, {}, withProfile)
      const s = await w.start()
      const peer = w.peers[0]!
      s.send('first')
      await peer.next(isPrompt)
      peer.update(SID, { sessionUpdate: 'usage_update', used: before, size: 200_000 })
      peer.release('session/prompt', end)
      await w.event((e) => e.type === 'turn_complete')
      s.send(text, sendOpts)
      await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(text))
      peer.update(SID, { sessionUpdate: 'usage_update', used: after, size: 200_000 })
      peer.release('session/prompt', end)
      await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'turn_complete').length === 2)
      return w.events
    }

    it('marks a compaction at the end of the compact turn Centralu started, when the reading went down', async () => {
      const events = await compactAfter('/compact', { compact: true }, inferring)
      expect(events.filter((e) => e.type === 'compaction')).toEqual([{ type: 'compaction', sessionId: 's1', failed: false, trigger: 'manual' }])
      // Before the turn's end, so the ending event is the compact's
      expect(events.findIndex((e) => e.type === 'compaction')).toBeLessThan(events.findLastIndex((e) => e.type === 'turn_complete'))
    })

    it('marks none for the person typing /compact, a reading that did not go down, or a tool that does not infer', async () => {
      expect((await compactAfter('/compact', {}, inferring)).some((e) => e.type === 'compaction')).toBe(false)
      expect((await compactAfter('/compact', { compact: true }, inferring, 9_889, 9_950)).some((e) => e.type === 'compaction')).toBe(false)
      expect((await compactAfter('/compact', { compact: true }, profile)).some((e) => e.type === 'compaction')).toBe(false)
    })
  })

  describe('whether Centralu may compact the session (#1451, §5.6)', () => {
    const commands = (...names: string[]) => ({ sessionUpdate: 'available_commands_update', availableCommands: names.map((name) => ({ name, description: name })) })

    /** A session whose agent advertised `names` during its first turn */
    async function advertising(names: string[], withProfile: AcpProfile = profile) {
      const w = world(base, {}, withProfile)
      const s = await w.start()
      const peer = w.peers[0]!
      s.send('go')
      await peer.next(isPrompt)
      peer.update(SID, commands(...names))
      peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
      await w.event((e) => e.type === 'turn_complete')
      return s
    }

    it('has no compact command when the agent advertises none (Antigravity 1.4.3: plan, logout, usage)', async () => {
      expect((await advertising(['plan', 'logout', 'usage'])).compactCommand?.(null)).toBeNull()
    })

    it('sends /compact to an agent that advertises it, and to one measured to compact on it without saying so', async () => {
      expect((await advertising(['compact', 'usage'])).compactCommand?.('keep the PR')).toBe('/compact')
      // OpenCode 1.19.4 compacts on `/compact` but does not list it
      expect((await advertising(['init', 'review'], { ...profile, infersCompaction: true })).compactCommand?.(null)).toBe('/compact')
    })

    it('keeps the commands an agent advertises during the replay of a load, as Antigravity does', async () => {
      const loading: PeerScript = (method, params, peer) => {
        if (method === 'session/load') {
          peer.update(String(params.sessionId), commands('compact', 'usage'))
          return { result: {} }
        }
        return base(method, params, peer)
      }
      const w = world(loading, { resumeExternalId: SID })
      const s = await w.start()
      expect((await s.listCommands?.())?.map((c) => c.name)).toEqual(['compact', 'usage'])
      expect(s.compactCommand?.(null)).toBe('/compact')
    })
  })

  it("says a compaction in protocol frames is manual inside Centralu's compact turn, and auto elsewhere", async () => {
    const w = world()
    const s = await w.start()
    const peer = w.peers[0]!
    for (const [text, opts] of [['go', {}], ['/compact', { compact: true }]] as const) {
      s.send(text, opts)
      await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(text))
      peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: text, status: 'completed' })
      peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
      await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'compaction').length === (text === 'go' ? 1 : 2))
    }
    expect(w.events.filter((e) => e.type === 'compaction').map((e) => e.type === 'compaction' && e.trigger)).toEqual(['auto', 'manual'])
  })

  it("carries a turn's spend to the next turn it reports when it ended with no usage to carry the cost (review of PR 3)", async () => {
    const w = world()
    const s = await w.start()
    const peer = w.peers[0]!
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    for (const [text, total, withUsage] of [['one', 0.1, true], ['two', 0.25, false], ['three', 0.3, true]] as const) {
      s.send(text)
      await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(text))
      peer.update(SID, { sessionUpdate: 'usage_update', used: 1_000, size: 200_000, cost: { amount: total, currency: 'USD' } })
      peer.release('session/prompt', { result: { stopReason: 'end_turn', ...(withUsage ? { usage } : {}) } })
      await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'turn_complete').length === (text === 'one' ? 1 : text === 'two' ? 2 : 3))
    }
    const costs = w.events.flatMap((e) => (e.type === 'usage_update' ? [e.tokens.costUsd] : []))
    expect(costs).toHaveLength(2)
    // A running reading: the agent's total, which the carried spend completes
    expect(costs[1]).toBeCloseTo(0.3)
  })

  it("takes a turn's cost as what it added to the running total the agent sends, a new conversation's from 0", async () => {
    const kept: number[] = []
    const w = world(base, { runningCost: { last: 5, keep: (t) => kept.push(t) } })
    const s = await w.start()
    expect(await turnCosts(w, s, [0.1, 0.25])).toEqual([0.1, 0.25].map(near))
    expect(kept).toEqual([0, 0.1, 0.25])
  })

  it("keeps the total across a new process, so the first turn after a restart or a host swap has its cost (review of PR 3)", async () => {
    const kept: number[] = []
    const resumed = world(base, { resumeExternalId: SID, runningCost: { last: 0.1, keep: (t) => kept.push(t) } })
    expect(await turnCosts(resumed, await resumed.start(), [0.25])).toEqual([near(0.15)])
    expect(kept).toEqual([0.25])
    const unknown = world(base, { resumeExternalId: SID, runningCost: { last: null, keep: () => {} } })
    expect(await turnCosts(unknown, await unknown.start(), [0.25, 0.3])).toEqual([undefined, near(0.05)])
  })

  it("reports the tokens as a running reading, and each turn's input as a request for the cache accounting", async () => {
    const w = world()
    const s = await w.start()
    const peer = w.peers[0]!
    const turns = [
      { inputTokens: 100, outputTokens: 10, thoughtTokens: 5, cachedReadTokens: 1_000 },
      { inputTokens: 40, outputTokens: 4, cachedReadTokens: 1_100, cachedWriteTokens: 7 },
    ]
    for (const [i, usage] of turns.entries()) {
      s.send(`turn ${i}`)
      await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(`turn ${i}`))
      peer.release('session/prompt', { result: { stopReason: 'end_turn', usage } })
      await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'usage_update').length === i + 1)
    }
    const updates = w.events.flatMap((e) => (e.type === 'usage_update' ? [e] : []))
    expect(updates.map((e) => e.tokens)).toEqual([
      { inputTokens: 100, outputTokens: 15, cacheReadTokens: 1_000, cacheCreationTokens: 0 },
      { inputTokens: 140, outputTokens: 19, cacheReadTokens: 2_100, cacheCreationTokens: 7 },
    ])
    expect(updates.map((e) => e.request)).toEqual([
      { inputTokens: 100, cacheReadTokens: 1_000, outputTokens: 15 },
      { inputTokens: 40, cacheReadTokens: 1_100, cacheCreationTokens: 7, outputTokens: 4 },
    ])
  })

  it('closes a process a previous host left (with its open calls) before the launch, and opens the conversation again in a new one', async () => {
    const old = new FakeAcpPeer(base)
    let oldGone = false
    old.once('exit', () => (oldGone = true))
    const spawned: AgentProcess[] = []
    const goneAtSpawn: boolean[] = []
    const source: ProcessSource = {
      spawn: () => {
        goneAtSpawn.push(oldGone)
        const p = new FakeAcpPeer(base)
        spawned.push(p)
        return p
      },
      adopt: { process: old, openCalls: [{ callId: 'call-9', tool: 'Bash' }] },
    }
    // The launch sweeps folders a gone host left (Antigravity's), the one the old process runs in among them
    const goneAtLaunch: boolean[] = []
    const launching: AcpProfile = { ...profile, launch: async (o) => (goneAtLaunch.push(oldGone), profile.launch(o)) }
    const w = world(base, { processSource: source, resumeExternalId: SID }, launching)
    await w.start()
    expect(old.killed).toBe(true)
    // The new process loads the same conversation, so the old one is gone first
    expect(goneAtLaunch).toEqual([true])
    expect(goneAtSpawn).toEqual([true])
    expect(w.peers).toHaveLength(0)
    expect((spawned[0] as FakeAcpPeer).methods()).toEqual(['initialize', 'session/load'])
    expect(w.events.filter((e) => e.type === 'tool_result')).toMatchObject([{ callId: 'call-9', ok: false }])
  })
})

/**
 * Every turn ends (#1829): whatever is lost or cut on the way, a session the agent has no turn open for, or with no process,
 * does not read as in a turn. After each step (each waits for what it makes the adapter say) the session's state is read through
 * the shared state machine: in a turn exactly while the agent has one open.
 */
describe('every turn ends (#1829)', () => {
  type World = ReturnType<typeof world>
  type Session = Awaited<ReturnType<World['start']>>
  const stateOf = (events: NormalizedEvent[]) => events.reduce<SessionState>((s, e) => transition(s, e).state, 'idle')
  const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]
  const running: [string, (w: World, s: Session) => Promise<unknown>, boolean][] = [
    ['a message is sent', async (w, s) => (s.send('go'), w.peers[0]!.next(isPrompt)), true],
    ['the agent answers', async (w) => (w.peers[0]!.update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } }), w.event((e) => e.type === 'message_delta')), true],
  ]
  const card: (typeof running)[number] = ['a card is raised', async (w) => {
    void w.peers[0]!.ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: 'call-1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } }).catch(() => {})
    return w.event((e) => e.type === 'approval_request')
  }, true]
  const exits: (typeof running)[number] = ['the agent exits', async (w) => (w.peers[0]!.exit(1), w.event((e) => e.type === 'error')), false]
  const cases: Record<string, typeof running> = {
    'the agent exits mid-turn': [...running, exits],
    'the agent exits with a card open': [...running, card, exits],
    'a Stop with a card open': [
      ...running,
      card,
      ['Stop', async (w, s) => (s.interrupt(), w.peers[0]!.next((m) => m.method === 'session/cancel')), true],
      ['the agent ends the turn', async (w) => (w.peers[0]!.release('session/prompt', { result: { stopReason: 'cancelled' } }), w.event((e) => e.type === 'state_change' && e.state === 'waiting_input')), false],
    ],
  }
  for (const [name, steps] of Object.entries(cases)) {
    it(name, async () => {
      const w = world()
      const s = await w.start()
      for (const [what, act, turnOpen] of steps) {
        await act(w, s)
        expect(isInTurn(stateOf(w.events)), `after: ${what}`).toBe(turnOpen)
      }
    })
  }
  it('an update the agent sends after its turn ended is shown, and the session stays at its rest (#1830)', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    await w.peers[0]!.next(isPrompt)
    w.peers[0]!.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    w.peers[0]!.update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one more thing' } })
    await w.event((e) => e.type === 'message_delta' && e.text === 'one more thing')
    expect(stateOf(w.events)).toBe('waiting_input')
  })
})

describe('model and effort selection in ACP session', () => {
  const modelProfile: AcpProfile = {
    ...profile,
    shape: {
      supportsModelOption: true,
    },
  }

  const scriptWithModels: PeerScript = (method) => {
    if (method === 'initialize') return { result: INIT_RESULT }
    if (method === 'session/new') {
      return {
        result: {
          sessionId: SID,
          configOptions: [
            {
              id: 'model',
              category: 'model',
              type: 'select',
              currentValue: 'gemini-4-argon',
              options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }],
            },
            {
              id: 'thought_level',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
            },
          ],
        },
      }
    }
    if (method === 'session/set_config_option') return { result: {} }
    return { result: null }
  }

  it('sets model and effort during session creation if requested and supported', async () => {
    const w = world(scriptWithModels, { model: 'gemini-3.8-flash', effort: 'low' }, modelProfile)
    const s = await w.start()
    const peer = w.peers[0]!
    const setCalls = peer.received.filter((m) => m.method === 'session/set_config_option')
    expect(setCalls).toHaveLength(2)
    expect(setCalls[0]?.params).toEqual({ sessionId: SID, configId: 'model', value: 'gemini-3.8-flash' })
    expect(setCalls[1]?.params).toEqual({ sessionId: SID, configId: 'thought_level', value: 'low' })
    expect(s.takeOpenedSettings?.()).toEqual({ model: 'gemini-3.8-flash', effort: 'low' })
    expect(s.takeOpenedSettings?.()).toBeNull()
    await s.dispose()
  })

  it('does not send set_config_option when tool shape does not support model option', async () => {
    const w = world(scriptWithModels, { model: 'gemini-3.8-flash', effort: 'low' }, profile)
    const s = await w.start()
    const peer = w.peers[0]!
    const setCalls = peer.received.filter((m) => m.method === 'session/set_config_option')
    expect(setCalls).toHaveLength(0)
    expect(s.updateSettings).toBeUndefined()
    expect(s.takeOpenedSettings?.()).toBeNull()
    await s.dispose()
  })

  it('dispatches set_config_option on updateSettings', async () => {
    const w = world(scriptWithModels, {}, modelProfile)
    const s = await w.start()
    const peer = w.peers[0]!
    expect(peer.received.filter((m) => m.method === 'session/set_config_option')).toHaveLength(0)

    s.updateSettings?.({ model: 'claude-opus-5-5', effort: 'high' })
    await peer.next((m) => m.method === 'session/set_config_option' && (m.params as { configId: string }).configId === 'thought_level')
    const setCalls = peer.received.filter((m) => m.method === 'session/set_config_option')
    expect(setCalls).toHaveLength(2)
    expect(setCalls[0]?.params).toEqual({ sessionId: SID, configId: 'model', value: 'claude-opus-5-5' })
    expect(setCalls[1]?.params).toEqual({ sessionId: SID, configId: 'thought_level', value: 'high' })
    await s.dispose()
  })

  it('preserves existing model when config_option_update only updates effort', async () => {
    const w = world(scriptWithModels, { model: 'gemini-3.8-flash', effort: 'low' }, modelProfile)
    const s = await w.start()
    const peer = w.peers[0]!
    expect(s.takeOpenedSettings?.()).toEqual({ model: 'gemini-3.8-flash', effort: 'low' })

    peer.update(SID, {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'thought_level',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'low' }, { value: 'high' }],
        },
      ],
    })

    expect(s.takeOpenedSettings?.()).toEqual({ model: 'gemini-3.8-flash', effort: 'high' })
    await s.dispose()
  })

  it('does not adopt requested model when set_config_option fails', async () => {
    const failingScript: PeerScript = (method, params, peer) => {
      if (method === 'session/set_config_option') {
        return { error: { code: -32603, message: 'Peer rejected model' } }
      }
      return scriptWithModels(method, params, peer)
    }
    const w = world(failingScript, { model: 'gemini-3.8-flash' }, modelProfile)
    const s = await w.start()
    // Does not adopt 'gemini-3.8-flash', remains the peer's initial model
    expect(s.takeOpenedSettings?.()).toEqual({ model: 'gemini-4-argon', effort: 'medium' })
    await s.dispose()
  })
})

describe('interruptForInput in ACP session', () => {
  const interruptProfile: AcpProfile = {
    ...profile,
    shape: {
      interruptForInput: true,
    },
  }

  it('cancels running prompt and cancels session apps when human input arrives', async () => {
    // When disabled, human input does not cancel
    const cancelAllDisabled = vi.fn()
    const mockAppsDisabled: SessionApps = {
      cancelAll: cancelAllDisabled,
      current: () => [],
      noteCall: () => {},
      callEnded: () => {},
      close: () => {},
    }
    const wDisabled = world(base, { apps: mockAppsDisabled }, profile)
    const sDisabled = await wDisabled.start()
    sDisabled.send('first')
    await wDisabled.peers[0]!.next(isPrompt)
    sDisabled.send('second', { origin: { kind: 'human' } })
    expect(wDisabled.peers[0]!.received.some((m) => m.method === 'session/cancel')).toBe(false)
    expect(cancelAllDisabled).not.toHaveBeenCalled()
    await sDisabled.dispose()

    const cancelAll = vi.fn()
    const mockApps: SessionApps = {
      cancelAll,
      current: () => [],
      noteCall: () => {},
      callEnded: () => {},
      close: () => {},
    }
    const w = world(base, { apps: mockApps }, interruptProfile)
    const s = await w.start()
    const peer = w.peers[0]!

    s.send('first')
    await peer.next(isPrompt)

    // Non-human input does not trigger cancel
    s.send('auto', { origin: { kind: 'channel', server: 'centralu' } })
    expect(peer.received.some((m) => m.method === 'session/cancel')).toBe(false)
    expect(cancelAll).not.toHaveBeenCalled()

    // Human input triggers session/cancel and cancelAll()
    s.send('second', { origin: { kind: 'human' } })
    await peer.next((m) => m.method === 'session/cancel')
    expect(cancelAll).toHaveBeenCalledTimes(1)

    // Release the cancelled prompt
    peer.release('session/prompt', { result: { stopReason: 'cancelled' } })

    // Next queued prompt runs ('auto')
    await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes('auto'))
    await new Promise((r) => setImmediate(r))
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })

    // Then 'second' runs
    await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes('second'))
    await new Promise((r) => setImmediate(r))
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })

    await s.dispose()
  })
})

/**
 * A message's attachments in the prompt (docs/plans/acp-adapter.md §5.8): read from a real folder, one row per condition. An
 * image the agent cannot be handed is named by path, as every tool is told it, and the turn runs either way
 */
describe('attachments in the ACP prompt', () => {
  /** A 2x2 red PNG, the scenarios' picture */
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==', 'base64')
  const imageBlock = { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }
  const picture = (path: string): Attachment => ({ kind: 'image', path, name: 'picture.png', mime: 'image/png' })
  /** An agent that answers every prompt at once; `images`: what its `initialize` says of `promptCapabilities.image` */
  const agent = (images: boolean): PeerScript => (method, params, peer) =>
    method === 'initialize' ? { result: { ...INIT_RESULT, agentCapabilities: { ...INIT_RESULT.agentCapabilities, promptCapabilities: { image: images } } } }
    : method === 'session/prompt' ? { result: { stopReason: 'end_turn' } }
    : base(method, params, peer)
  const withImages = agent(true)

  const folders: string[] = []
  afterEach(async () => {
    await Promise.all(folders.splice(0).map(removeTree))
  })
  const folder = (files: Record<string, string | Buffer> = {}) => {
    const dir = tempRoot('cc-acp-attach-')
    folders.push(dir)
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    return dir
  }

  /** The prompt the agent is sent for one message, and that the turn it starts ends */
  async function prompted(cwd: string, attachments: Attachment[] | undefined, script: PeerScript = withImages) {
    const w = world(script, { cwd })
    const s = await w.start()
    s.send('What colour?', attachments ? { attachments } : undefined)
    const sent = (await w.peers[0]!.next(isPrompt)) as { params: { prompt: unknown[] } }
    await w.event((e) => e.type === 'turn_complete')
    await s.dispose()
    return sent.params.prompt
  }

  it('an image within the size, to an agent that takes images: an image block after the text, read relative to the session’s folder', async () => {
    expect(await prompted(folder({ 'picture.png': PNG }), [picture('picture.png')])).toEqual([{ type: 'text', text: 'What colour?' }, imageBlock])
  })

  it('an image by its absolute path (a pasted one, saved outside the project): read where it is', async () => {
    const saved = join(folder({ 'pasted.png': PNG }), 'pasted.png')
    expect(await prompted(folder(), [picture(saved)])).toEqual([{ type: 'text', text: 'What colour?' }, imageBlock])
  })

  it('an image to an agent that does not say it takes images: named by path', async () => {
    expect(await prompted(folder({ 'picture.png': PNG }), [picture('picture.png')], agent(false))).toEqual([{ type: 'text', text: 'What colour?\n\n@picture.png' }])
  })

  it('an image larger than an image event may be: named by path, though it is a whole picture', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES + 1 - PNG.length)])
    expect(await prompted(folder({ 'big.png': big }), [picture('big.png')])).toEqual([{ type: 'text', text: 'What colour?\n\n@big.png' }])
  })

  it('an image of exactly the largest size: an image block', async () => {
    const edge = Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES - PNG.length)])
    expect(await prompted(folder({ 'edge.png': edge }), [picture('edge.png')])).toEqual([{ type: 'text', text: 'What colour?' }, { type: 'image', mimeType: 'image/png', data: edge.toString('base64') }])
  })

  it('a file that is gone: named by path, and the turn runs', async () => {
    expect(await prompted(folder(), [picture('gone.png')])).toEqual([{ type: 'text', text: 'What colour?\n\n@gone.png' }])
  })

  it('an attachment said to be an image whose bytes are no picture: named by path', async () => {
    expect(await prompted(folder({ 'fake.png': 'not a picture' }), [picture('fake.png')])).toEqual([{ type: 'text', text: 'What colour?\n\n@fake.png' }])
  })

  it('a plain file is named by path, a file with an image mime is a picture, and the paths keep their order', async () => {
    const cwd = folder({ 'picture.png': PNG, 'notes.md': '# notes\n', 'shot': PNG })
    const files: Attachment[] = [{ kind: 'file', path: 'notes.md', name: 'notes.md' }, picture('picture.png'), { kind: 'file', path: 'shot', name: 'shot', mime: 'image/png' }, { kind: 'file', path: 'gone.md', name: 'gone.md' }]
    expect(await prompted(cwd, files)).toEqual([{ type: 'text', text: 'What colour?\n\n@notes.md\n@gone.md' }, imageBlock, imageBlock])
  })

  it('a picture sent as a file with no mime: named by path, its bytes not looked at', async () => {
    expect(await prompted(folder({ 'shot.png': PNG }), [{ kind: 'file', path: 'shot.png', name: 'shot.png' }])).toEqual([{ type: 'text', text: 'What colour?\n\n@shot.png' }])
  })

  it('no attachments: the one text block, as before', async () => {
    expect(await prompted(folder(), undefined)).toEqual([{ type: 'text', text: 'What colour?' }])
    expect(await prompted(folder(), [])).toEqual([{ type: 'text', text: 'What colour?' }])
  })

  it('keeps the queue’s order: a message sent behind one whose picture is being read is the next prompt, not the first', async () => {
    const w = world(withImages, { cwd: folder({ 'picture.png': PNG }) })
    const s = await w.start()
    s.send('first', { attachments: [picture('picture.png')] })
    s.send('second')
    await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'turn_complete').length === 2)
    const prompts = w.peers[0]!.received.filter(isPrompt) as { params: { prompt: { type: string; text?: string }[] } }[]
    expect(prompts.map((p) => p.params.prompt.map((b) => b.text ?? b.type))).toEqual([['first', 'image'], ['second']])
    await s.dispose()
  })

  it('a Stop pressed while the picture is read ends the turn as stopped, and the prompt is never sent', async () => {
    const w = world(withImages, { cwd: folder({ 'picture.png': PNG }) })
    const s = await w.start()
    s.send('first', { attachments: [picture('picture.png')] })
    s.interrupt()
    await w.event((e) => e.type === 'state_change' && e.state === 'waiting_input')
    expect(w.peers[0]!.methods().filter((m) => m === 'session/prompt')).toEqual([])
    s.send('second')
    await w.peers[0]!.next((m) => isPrompt(m) && JSON.stringify(m).includes('second'))
    expect(w.peers[0]!.methods().filter((m) => m === 'session/prompt')).toHaveLength(1)
    await s.dispose()
  })
})

