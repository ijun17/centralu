import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * compact is a function, not a message (a dogfooding observation).
 *
 * The app-server path has no CLI slash-command handler, so sending "/compact" through
 * turn/start makes the model **read the literal characters** — no compaction happens, and the
 * screen looks like it was sent. This checks, through the request log, whether it is intercepted
 * by the dedicated RPC (thread/compact/start), and whether that check is not too broad (swallowing
 * a real message would be a new bug).
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  /** The notification callback the session registered — used by tests to simulate turn/completed */
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
  /** A method listed here fails — for the compact-start-failure path */
  failMethods: new Set<string>(),
  /** The status thread/goal/set returns (there are cases where codex leaves it as complete while only swapping the objective) */
  goalStatus: 'active' as string,
  /** If true, that status stays even after clearing and setting again — the "still does not come back" case */
  goalSetSticky: false,
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (state.failMethods.has(method)) return Promise.reject(new Error(`${method} failed (test)`))
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'thread/goal/set') {
        const status = state.goalStatus
        // The second set comes back active because it follows a clear — the mock follows the same flow as the real thing
        if (state.goalSetSticky !== true) state.goalStatus = 'active'
        return Promise.resolve({ goal: { status } })
      }
      if (method === 'skills/list') {
        return Promise.resolve({
          data: [{ skills: [{ name: 'deploy', description: 'Deploy' }, { name: 'compact', description: 'Duplicate' }] }],
        })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const methods = () => state.requests.map((r) => r.method)
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.requests.length = 0
  state.failMethods.clear()
  state.goalStatus = 'active'
  state.goalSetSticky = false
})

async function session(emit: (e: unknown) => void = () => {}) {
  const adapter = new CodexAdapter()
  const handle = await adapter.createSession(
    { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' },
    emit as Parameters<typeof adapter.createSession>[1],
  )
  return handle
}

describe('codex /compact — runs as a function', () => {
  it('/compact goes to thread/compact/start, not turn/start', async () => {
    const h = await session()
    h.send('/compact')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('thread/compact/start')
    expect(methods()).not.toContain('turn/start')
    expect(state.requests.find((r) => r.method === 'thread/compact/start')?.params).toEqual({ threadId: 't1' })
  })

  it('is lenient about surrounding whitespace — " /compact " is also the function', async () => {
    const h = await session()
    h.send('  /compact  ')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('thread/compact/start')
  })

  it('"/compact something else" is a message — too broad a check would swallow real text', async () => {
    const h = await session()
    h.send('/compact this later')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('turn/start')
    expect(methods()).not.toContain('thread/compact/start')
  })

  it('compact appears in the autocomplete list — a command that exists but is invisible is a lie the list tells', async () => {
    const h = await session()
    const cmds = await h.listCommands!()
    // Only one entry survives even if skills/list also carries the same name
    expect(cmds.filter((c) => c.name === 'compact')).toHaveLength(1)
    expect(cmds.some((c) => c.name === 'deploy')).toBe(true)
    expect(cmds.some((c) => c.name === 'review')).toBe(true)
  })
})

/**
 * /review is a function too (the review/start RPC — measured: the result streams as
 * agentMessage). One difference from compact: **the argument has meaning** — with one, it
 * follows that instruction (custom); without one, it is the same "what has changed right now"
 * (uncommittedChanges) as the codex CLI's default.
 */
describe('codex /review — runs as a function', () => {
  it('with no argument, it is an uncommittedChanges review', async () => {
    const h = await session()
    h.send('/review')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('review/start')
    expect(methods()).not.toContain('turn/start')
    expect(state.requests.find((r) => r.method === 'review/start')?.params).toEqual({
      threadId: 't1',
      target: { type: 'uncommittedChanges' },
    })
  })

  it('with an argument, it reviews following that instruction instead (custom)', async () => {
    const h = await session()
    h.send('/review with a focus on security')
    await new Promise((r) => setTimeout(r, 0))
    expect(state.requests.find((r) => r.method === 'review/start')?.params).toEqual({
      threadId: 't1',
      target: { type: 'custom', instructions: 'with a focus on security' },
    })
  })

  it('"/reviewer job posting" is a message — a similar-looking prefix must not swallow it', async () => {
    const h = await session()
    h.send('/reviewer write a job posting')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('turn/start')
    expect(methods()).not.toContain('review/start')
  })
})

/**
 * While compact is running, codex (0.147.0) **answers success while dropping** input that came
 * in through turn/start — measured while dogfooding (2026-09-02, MGH session): the rollout kept
 * only the settings application, not a single line of the user message, and since no error came
 * back either, the screen was left showing it as sent. Upstream also classifies compact/review
 * turns as unsteerable ("cannot steer a compact turn"). So this checks whether the adapter queues
 * messages sent during that window and flushes them once the turn ends.
 */
describe('codex compact/review — messages are not sent to the spot that drops them', () => {
  it('queues during compact, and sends them as one turn, in order, once it ends', async () => {
    const h = await session()
    h.send('/compact')
    await tick()
    h.send('first message')
    h.send('second message')
    await tick()
    // If turn/start had gone out here, codex would have dropped it
    expect(methods()).not.toContain('turn/start')

    state.handlers!.onNotification({ method: 'turn/completed', params: {} })
    await tick()
    const turn = state.requests.find((r) => r.method === 'turn/start')
    expect(turn?.params?.input).toEqual([
      { type: 'text', text: 'first message' },
      { type: 'text', text: 'second message' },
    ])
  })

  it('a message sent after compact ends goes out immediately — the queue must not outlive its purpose', async () => {
    const h = await session()
    h.send('/compact')
    await tick()
    state.handlers!.onNotification({ method: 'turn/completed', params: {} })
    await tick()
    h.send('message sent after it finished')
    await tick()
    expect(state.requests.find((r) => r.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: 'message sent after it finished' },
    ])
  })

  it('the same holds during review — upstream classifies both as unsteerable', async () => {
    const h = await session()
    h.send('/review')
    await tick()
    h.send('message sent during review')
    await tick()
    expect(methods()).not.toContain('turn/start')
    state.handlers!.onNotification({ method: 'turn/completed', params: {} })
    await tick()
    expect(state.requests.find((r) => r.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: 'message sent during review' },
    ])
  })

  it('if starting compact fails, the queue unblocks — a locked queue is a permanent loss', async () => {
    state.failMethods.add('thread/compact/start')
    const events: { type: string }[] = []
    const h = await session((e) => events.push(e as { type: string }))
    h.send('/compact')
    h.send('message sent alongside it')
    await tick()
    await tick()
    // The failure is reported, and the queued message still goes out
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(
      state.requests.some(
        (r) => r.method === 'turn/start' && JSON.stringify(r.params?.input).includes('message sent alongside it'),
      ),
    ).toBe(true)
  })

  it('reports it when disposed without delivering — the screen already shows it as sent', async () => {
    const events: { type: string; error?: { message: string } }[] = []
    const h = await session((e) => events.push(e as { type: string; error?: { message: string } }))
    h.send('/compact')
    await tick()
    h.send('a message that might get lost')
    await tick()
    await h.dispose()
    expect(events.some((e) => e.type === 'error' && /not delivered/.test(e.error?.message ?? ''))).toBe(true)
  })
})

/**
 * /goal is the same kind of thing (2026-09-07 — #58: sending a function as a message makes the
 * model read the literal characters). This checks whether it is intercepted by the three RPCs
 * (set, get, clear), whether the check is not too broad, and whether a one-line confirmation is
 * left in the chat (if a local command's answer is invisible, there is no way to know it ran).
 */
describe('codex /goal — runs as a function', () => {
  it('/goal <objective> → thread/goal/set + a one-line confirmation, no turn/start', async () => {
    const events: { type: string; text?: string }[] = []
    const h = await session((e) => events.push(e as { type: string; text?: string }))
    h.send('/goal all tests green')
    await tick()
    const set = state.requests.find((r) => r.method === 'thread/goal/set')
    expect(set?.params).toMatchObject({ threadId: 't1', objective: 'all tests green' })
    expect(methods()).not.toContain('turn/start')
    expect(events.some((e) => e.type === 'message_delta' && /Goal set/.test(e.text ?? ''))).toBe(true)
  })

  /*
   * Dogfooding 2026-09-08: "it looks registered but does not do anything". Measurement showed
   * that thread already had a finished goal, and codex left status at complete while only
   * swapping in the new objective. If we had just answered "Goal set" at that point, the screen
   * would look like it worked while the goal loop never ran.
   */
  it('setting a new goal on top of a finished one clears it and sets again — a new goal means starting over', async () => {
    state.goalStatus = 'complete'
    const events: { type: string; text?: string }[] = []
    const h = await session((e) => events.push(e as { type: string; text?: string }))
    h.send('/goal finish the refactor')
    await tick()
    await tick()
    await tick()
    expect(methods()).toContain('thread/goal/clear')
    expect(state.requests.filter((r) => r.method === 'thread/goal/set')).toHaveLength(2)
    expect(events.some((e) => /Goal set: finish the refactor/.test(e.text ?? ''))).toBe(true)
  })

  it('if it is still not active after clearing and setting again, states that status — does not make one up', async () => {
    state.goalStatus = 'complete'
    state.goalSetSticky = true
    const events: { type: string; text?: string }[] = []
    const h = await session((e) => events.push(e as { type: string; text?: string }))
    h.send('/goal finish the refactor')
    await tick()
    await tick()
    await tick()
    expect(events.some((e) => /Goal set \(complete\)/.test(e.text ?? ''))).toBe(true)
  })

  it('/goal alone → thread/goal/get, states the current goal in one line', async () => {
    const events: { type: string; text?: string }[] = []
    const h = await session((e) => events.push(e as { type: string; text?: string }))
    h.send('/goal')
    await tick()
    expect(methods()).toContain('thread/goal/get')
    expect(methods()).not.toContain('turn/start')
  })

  it('/goal clear → thread/goal/clear', async () => {
    const h = await session()
    h.send('/goal clear')
    await tick()
    expect(methods()).toContain('thread/goal/clear')
    expect(methods()).not.toContain('turn/start')
  })

  it('the check is narrow — a real message like "tell me about /goal" is not swallowed', async () => {
    const h = await session()
    h.send('talking about goal setting: what is the /goal syntax?')
    await tick()
    expect(methods()).toContain('turn/start')
    expect(methods()).not.toContain('thread/goal/set')
  })
})
