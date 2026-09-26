import { beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'

/**
 * 세션 수명주기의 경주 — 프로세스를 갈아 끼우거나 깨우는 **도중에** 다른 일이 끼는 경우.
 *
 * 가짜 어댑터는 두 가지를 테스트 손에 쥐여 준다: 핸들마다 받은 이벤트 받이(`emit`) — 내려놓은 핸들이
 * 늦게 말하는 모양을 만든다 — 와, 멈춰 둘 수 있는 `createSession` — 깨우는 중인 창을 만든다.
 */
class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  sent: string[] = []
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
  ) {}
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    this.disposed = true
  }
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false,
  }
  created: Handle[] = []
  /** 켜 두면 createSession이 `release()`를 부를 때까지 멈춘다 — 깨우는 중인 창 */
  gate: Promise<void> | null = null
  private open: (() => void) | null = null
  constructor(readonly tool: ToolName) {}
  hold() {
    this.gate = new Promise((r) => (this.open = r))
  }
  release() {
    this.gate = null
    this.open?.()
  }
  get last() {
    return this.created.at(-1)!
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    if (this.gate) await this.gate
    const h = new Handle(opts.sessionId, opts, emit)
    if (opts.resumeExternalId) h.externalId = opts.resumeExternalId
    this.created.push(h)
    return h
  }
}

let store: Store
let claude: Adapter
let codex: Adapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  store = new Store()
  claude = new Adapter('claude')
  codex = new Adapter('codex')
  events = []
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', codex]])
  mgr = new SessionManager(store, adapters, (e) => events.push(e))
  rpc = createRpcHandler(mgr, adapters)
})

async function newSession(preset: 'safe' | 'normal' | 'auto' = 'normal'): Promise<string> {
  const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: preset })) as {
    id: string
  }
  return s.id
}

const texts = (sessionId: string) =>
  store.loadMessages(sessionId, 100).map((r) => JSON.stringify(r.payload))

describe('갈아 끼운 프로세스의 늦은 말 (#157)', () => {
  it('재시작 뒤 옛 핸들이 adapter_crashed를 올려도 새 핸들이 남고, 옛 턴의 글과 끝은 기록되지 않는다', async () => {
    const id = await newSession()
    const old = claude.last
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: '옛 턴의 앞부분' })

    // 설정을 바꾸면 프로세스를 갈아 끼운다
    await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    const fresh = claude.last
    expect(fresh).not.toBe(old)
    expect(old.disposed).toBe(true)

    // 옛 프로세스가 끝나 가던 턴을 마저 내고, 오류 result를 안은 채 죽는다
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: '옛 프로세스의 늦은 글' })
    old.emit({ type: 'turn_complete', sessionId: id })
    old.emit({
      type: 'error',
      sessionId: id,
      error: { code: 'adapter_crashed', message: 'Claude Code returned an error result: x', retryable: true },
    })

    expect(fresh.disposed).toBe(false)
    expect(mgr.isLive(id)).toBe(true)
    expect(events.some((e) => e.type === 'error' && e.error.code === 'adapter_crashed')).toBe(false)
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false)
    expect(texts(id).some((t) => t.includes('옛 프로세스의 늦은 글'))).toBe(false)

    // 새 핸들의 크래시는 지금처럼 걷는다 — 가드가 크래시 분기를 통째로 막은 것이 아니다
    fresh.emit({ type: 'error', sessionId: id, error: { code: 'adapter_crashed', message: 'gone', retryable: true } })
    expect(fresh.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
  })

  it('내려놓은 핸들이 닫으며 놓아주는 승인 카드는 받는다 — 카드가 남지 않게', async () => {
    const id = await newSession('safe')
    const old = claude.last
    old.emit({ type: 'approval_request', sessionId: id, requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    expect(mgr.listSessions().find((s) => s.id === id)!.pendingApproval?.requestId).toBe('r1')

    await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    old.emit({ type: 'approval_resolved', sessionId: id, requestId: 'r1', decision: 'deny' })

    expect(mgr.listSessions().find((s) => s.id === id)!.pendingApproval ?? null).toBe(null)
  })
})
