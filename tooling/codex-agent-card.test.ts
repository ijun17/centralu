import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { appendChat, type ChatItem } from '../packages/ui/src/store/transcript.js'

/**
 * A Codex child agent's steps reach the screen (#843): the adapter's events, in the order a real run sends them, folded
 * into the conversation the way the window folds them (`appendChat`). The adapter test alone passed while the screen
 * showed nothing: the `spawnAgent` item completes before the child does anything, and the conversation draws live
 * output only on a card still open. This crosses the host and the UI, which no package's own tests may import
 * together, so it lives here.
 *
 * The shapes and order are those measured live (scripts/probe-codex-subagent.mts, codex-cli 0.160.0), the same as
 * agent-host's subagent-thread.test.ts.
 */
const state = vi.hoisted(() => ({
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
}))

vi.mock('../packages/agent-host/src/adapters/codex/client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string): Promise<unknown> {
      return Promise.resolve(method === 'thread/start' ? { thread: { id: 'parent-thread' } } : {})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('../packages/agent-host/src/adapters/codex/index.js')

const CHILD = '01a0fefe-fb63-7651-8db6-90b34dc90f00'
const SPAWN = 'exec-91551a68-2713-4d0f-b31c-91da3ce6a2f1'
const spawn = (method: 'item/started' | 'item/completed') => ({
  threadId: 'parent-thread',
  turnId: 't',
  item: {
    type: 'collabAgentToolCall', id: SPAWN, tool: 'spawnAgent', status: method === 'item/started' ? 'inProgress' : 'completed',
    senderThreadId: 'parent-thread', receiverThreadIds: method === 'item/started' ? [] : [CHILD],
    prompt: 'Run the shell command `echo pong-from-child`, then reply with exactly the word pong.',
    model: null, reasoningEffort: null, agentsStates: {},
  },
})
const command = (method: 'item/started' | 'item/completed') => ({
  threadId: CHILD,
  turnId: 'c',
  item: {
    type: 'commandExecution', id: 'exec-cmd', command: "/bin/zsh -lc 'echo pong-from-child'", cwd: '/tmp',
    status: method === 'item/started' ? 'inProgress' : 'completed', aggregatedOutput: method === 'item/started' ? null : 'pong-from-child\n',
  },
})

beforeEach(() => {
  state.handlers = null
})

describe("a codex child agent's steps on its launch card, as the window draws them (#843)", () => {
  it('the card shows the child at work while it runs, and closes when the child ends', async () => {
    let chat: ChatItem[] = []
    const events: NormalizedEvent[] = []
    await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => {
      events.push(e)
      chat = appendChat(chat, e)
    })
    const notify = (method: string, params: unknown) => state.handlers!.onNotification({ method, params })
    const card = () => chat.find((it) => it.kind === 'tool' && it.callId === SPAWN) as Extract<ChatItem, { kind: 'tool' }> | undefined

    notify('turn/started', { threadId: 'parent-thread', turn: { id: 't' } })
    notify('item/started', spawn('item/started'))
    notify('turn/started', { threadId: CHILD, turn: { id: 'c' } })
    notify('item/completed', spawn('item/completed'))
    notify('item/started', command('item/started'))

    // The spawn item already completed; the child is working, and the card says what it does
    expect(card()?.tool).toBe('spawnAgent')
    expect(card()?.result).toBeUndefined()
    expect(card()?.live).toContain("Bash: /bin/zsh -lc 'echo pong-from-child'")

    notify('item/completed', command('item/completed'))
    notify('item/completed', { threadId: CHILD, turnId: 'c', item: { type: 'agentMessage', id: 'msg_1', text: 'pong' } })
    notify('turn/completed', { threadId: CHILD, turn: { id: 'c', status: 'completed' } })

    // The child ended: the card closes, and the live tail gives way to the result
    expect(card()?.result).toBeDefined()
    expect(card()?.ok).toBe(true)
    expect(card()?.live).toBeUndefined()
    expect(events.filter((e) => 'callId' in e && e.callId === SPAWN).map((e) => e.type)).toEqual(['tool_call', 'tool_output_delta', 'tool_result'])
  })
})
