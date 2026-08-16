import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AdapterCapabilities, ApprovalDecision, ApprovalScope, PermissionPreset } from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { CodexClient } from './client.js'
import { listCodexThreads, readCodexHistory } from './history.js'
import { readCodexUsage } from './usage-client.js'
import { approvalDetailFrom, normalizeNotification, toCodexDecision } from './normalize.js'

const exec = promisify(execFile)

/**
 * Codex 어댑터 (M0에서 프로토콜·승인 오버라이드 검증 완료).
 *
 * 설계 검증 대상(A-4): 이 디렉토리만 추가해서 UI·core가 그대로인가.
 * 규칙: Codex 타입은 여기서 끝난다 — 밖으로 나가는 것은 NormalizedEvent뿐.
 */

/** 권한 프리셋 → Codex approvalPolicy. 전역 설정(`~/.codex/config.toml`)을 세션 단위로 덮어쓴다 */
function approvalPolicyFor(preset: PermissionPreset): string {
  if (preset === 'safe') return 'untrusted' // 모든 것을 묻는다
  if (preset === 'auto') return 'never' // 묻지 않는다
  return 'on-request' // 기본: 도구가 필요하다고 판단할 때만
}

class CodexSession implements SessionHandle {
  readonly sessionId: string
  externalId: string | null = null

  private client: CodexClient
  private threadId: string | null = null
  /** 우리 requestId → Codex 서버 요청 id */
  private approvals = new Map<string, number | string>()
  private reqCounter = 0
  private alwaysAllow = new Set<string>()
  /** 스레드 준비 완료 — 생성 시점에 await해 externalId를 확보한다 */
  readonly ready: Promise<void>

  constructor(
    private opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.sessionId = opts.sessionId
    this.client = new CodexClient(
      {
        onNotification: (n) => this.onNotification(n),
        onServerRequest: (r) => this.onServerRequest(r),
        onExit: (code) =>
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: {
              code: 'adapter_crashed',
              message: `codex app-server가 종료되었습니다 (code ${code ?? 'null'})`,
              retryable: true,
            },
          }),
      },
      { cwd: opts.cwd, command: whichTool('codex') ?? 'codex' },
    )
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    await this.client.request('initialize', {
      clientInfo: { name: 'control-center', title: 'Control Center', version: '0.1.0' },
      capabilities: null,
    })
    this.client.notify('initialized')

    if (this.opts.resumeExternalId) {
      // 재개 (FR-10). 실패하면 세션 매니저가 폴백을 안내한다
      let res: Record<string, unknown>
      try {
        res = await this.client.request<Record<string, unknown>>('thread/resume', {
          threadId: this.opts.resumeExternalId,
        })
      } catch (err) {
        // 원문("already has an active writer")은 사용자에게 아무것도 설명하지 못한다
        const msg = (err as Error).message
        throw /active writer/i.test(msg)
          ? new Error('이 대화를 다른 곳에서 이미 열고 있습니다 (터미널의 codex이거나 다른 세션)')
          : err
      }
      this.threadId = threadIdOf(res) ?? this.opts.resumeExternalId
    } else {
      const res = await this.client.request<Record<string, unknown>>('thread/start', {
        cwd: this.opts.cwd,
        approvalPolicy: approvalPolicyFor(this.opts.permissionPreset),
        sandbox: 'workspace-write',
        model: this.opts.model,
      })
      this.threadId = threadIdOf(res)
    }
    this.externalId = this.threadId
  }

  private onNotification(n: { method: string; params?: unknown }): void {
    for (const e of normalizeNotification(this.sessionId, n)) this.emit(e)
  }

  private onServerRequest(r: { id: number | string; method: string; params?: unknown }): void {
    if (!r.method.includes('requestApproval') && !r.method.endsWith('Approval')) {
      // 승인이 아닌 서버 요청은 빈 응답으로 흘려보낸다 (프로토콜이 늘어나도 멈추지 않게)
      this.client.respond(r.id, {})
      return
    }
    const params = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as Record<string, unknown>
    const detail = approvalDetailFrom(r.method, params)

    // 저장된 '항상 허용' 규칙에 맞으면 묻지 않는다 (C-2와 같은 규칙)
    const key = detail.kind === 'command' ? detail.command : detail.kind === 'file_edit' ? detail.path : ''
    if (key && this.isAlwaysAllowed(key)) {
      this.client.respond(r.id, { decision: 'accept' })
      return
    }

    const requestId = `codex-req-${++this.reqCounter}`
    this.approvals.set(requestId, r.id)
    this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId, detail })
  }

  private isAlwaysAllowed(key: string): boolean {
    for (const m of this.alwaysAllow) {
      if (m.endsWith('*') ? key.startsWith(m.slice(0, -1)) : key === m) return true
    }
    return false
  }

  applyRules(matchers: readonly string[]): void {
    for (const m of matchers) this.alwaysAllow.add(m)
  }

  send(text: string): void {
    void this.ready.then(() => {
      if (!this.threadId) throw new Error('스레드가 준비되지 않았습니다')
      return this.client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      })
    }).catch((e: Error) => {
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: { code: 'internal', message: e.message, retryable: true },
      })
    })
  }

  respondApproval(requestId: string, decision: ApprovalDecision, _scope?: ApprovalScope, matcher?: string): void {
    const serverId = this.approvals.get(requestId)
    if (serverId === undefined) return
    this.approvals.delete(requestId)

    if (decision === 'always' && matcher) this.alwaysAllow.add(matcher)
    this.client.respond(serverId, { decision: toCodexDecision(decision) })
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
  }

  /** 슬래시 명령(스킬) — app-server의 공식 RPC */
  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    const res = await this.client.request<{ data?: unknown }>('skills/list', {})
    const groups = Array.isArray(res?.data) ? res.data : []
    const out: { name: string; description?: string }[] = []
    for (const g of groups) {
      const skills = (g as { skills?: unknown }).skills
      if (!Array.isArray(skills)) continue
      for (const s of skills) {
        const skill = (s ?? {}) as { name?: unknown; description?: unknown; enabled?: unknown }
        if (typeof skill.name !== 'string' || skill.enabled === false) continue
        out.push({
          name: skill.name,
          description: typeof skill.description === 'string' ? skill.description : '',
        })
      }
    }
    return out
  }

  interrupt(): void {
    if (this.threadId) void this.client.request('turn/interrupt', { threadId: this.threadId }).catch(() => {})
  }

  async dispose(): Promise<void> {
    await this.client.dispose()
  }
}

function threadIdOf(res: Record<string, unknown> | undefined): string | null {
  if (!res) return null
  const thread = res.thread as Record<string, unknown> | undefined
  const id = (thread?.id ?? res.threadId) as string | undefined
  return typeof id === 'string' ? id : null
}

export class CodexAdapter implements AgentAdapter {
  readonly tool = 'codex' as const

  readonly capabilities: AdapterCapabilities = {
    approvals: true, // M0 실측: thread/start의 approvalPolicy가 전역 설정을 덮어쓴다
    contextUsage: 'exact', // thread/tokenUsage/updated
    resume: true, // thread/resume
    autoTitle: true, // thread/name/updated
    attachments: ['image', 'file'],
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('codex')
    try {
      const { stdout } = await exec(path ?? 'codex', ['--version'], { timeout: 5000 })
      const version = `${stdout.trim()} · ${path ?? 'PATH'}`
      // 로그인 여부는 인증 파일 존재로 판단한다 (CLI를 띄우지 않고 값싸게)
      const loggedIn = existsSync(join(homedir(), '.codex', 'auth.json'))
      return {
        tool: 'codex',
        installed: true,
        loggedIn,
        detail: loggedIn ? version : `${version} · 로그인 필요`,
      }
    } catch {
      return {
        tool: 'codex',
        installed: false,
        loggedIn: false,
        detail: 'codex CLI를 찾을 수 없습니다 (터미널에서 which codex 로 확인)',
      }
    }
  }

  listExternalSessions(cwd: string, limit: number) {
    return listCodexThreads(cwd, limit, whichTool('codex') ?? 'codex')
  }

  /**
   * 계정 사용량 (FR-9).
   * 세션과 무관하므로 단명 클라이언트로 묻는다 — 대화 중인 스레드에 조회를 얹지 않는다.
   */
  async listUsage() {
    return readCodexUsage(whichTool('codex') ?? 'codex')
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readCodexHistory(externalId, cwd, limit, whichTool('codex') ?? 'codex')
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const session = new CodexSession(opts, emit)
    // 스레드 id가 생겨야 재개가 가능하다 — 생성 시점에 확보한다 (M1.5 결함 5번 교훈)
    await session.ready
    return session
  }
}
