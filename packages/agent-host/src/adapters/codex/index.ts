import { execFile } from 'node:child_process'
import { bridgePath } from './bridge-path.js'

/** 다리로 붙는 우리 MCP 서버 이름 — 승인 예외가 이 이름으로 판정한다 */
const ORCHESTRATOR_MCP_SERVER = 'control_center'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CLIENT_INFO } from '@cc/protocol'
import type { AdapterCapabilities, ApprovalDecision, ApprovalScope, PermissionPreset } from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { CodexClient } from './client.js'
import { listCodexThreads, readCodexHistory } from './history.js'
import { readCodexUsage } from './usage-client.js'
import { listCodexModels } from './models.js'
import { approvalDetailFrom, normalizeNotification, toCodexDecision } from './normalize.js'

const exec = promisify(execFile)

/**
 * Codex 어댑터 (M0에서 프로토콜·승인 오버라이드 검증 완료).
 *
 * 설계 검증 대상(A-4): 이 디렉토리만 추가해서 UI·core가 그대로인가.
 * 규칙: Codex 타입은 여기서 끝난다 — 밖으로 나가는 것은 NormalizedEvent뿐.
 */

/**
 * 권한 프리셋 → Codex의 권한 옵션.
 *
 * Claude 쪽과 **같은 원칙**이다: normal은 우리가 정하지 않고 도구 자신의 설정
 * (`~/.codex/config.toml`)을 따른다. 그래서 아무 키도 넣지 않는다 — codex는 빠진 값을
 * 자기 설정에서 채운다.
 *
 * 덮어쓰던 것이 둘이었다는 점이 중요하다. approvalPolicy만이 아니라 **sandbox도**
 * 'workspace-write'로 못박고 있었다. 사용자가 config.toml에 danger-full-access를
 * 적어 두었어도 작업 폴더 밖은 막혀 있었다는 뜻이다 — 묻지도 않고 실패한다.
 */
function permissionOptionsFor(preset: PermissionPreset): Record<string, unknown> {
  if (preset === 'safe') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } // 모든 것을 묻는다
  if (preset === 'auto') return { approvalPolicy: 'never', sandbox: 'workspace-write' } // 묻지 않는다
  return {} // 내 설정을 따른다
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
        /*
         * **우리가 닫은 것을 죽었다고 말하지 않는다.**
         *
         * 여기가 조사 하루를 통째로 먹은 자리다. 잠긴 스레드를 이어가려다 실패하면
         * 매니저가 세션을 정리하는데(dispose), 그 정상 종료가 다시 이 자리로 와서
         * `adapter_crashed`를 올렸다. 화면에는 "codex app-server exited"만 남고
         * 진짜 이유("already has an active writer")는 그 아래 깔려 보이지 않았다.
         * 죽지도 않은 프로세스를 죽었다고 말하니, 원인을 찾을 길이 없었다.
         */
        onExit: (code, expected) => {
          if (expected) return
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: {
              code: 'adapter_crashed',
              message: `codex app-server exited (code ${code ?? 'null'})`,
              retryable: true,
            },
          })
        },
      },
      { cwd: opts.cwd, command: whichTool('codex') ?? 'codex' },
    )
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    await this.client.request('initialize', {
      clientInfo: CLIENT_INFO,
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
        /*
         * 원문("already has an active writer")은 사용자에게 아무것도 설명하지 못한다.
         *
         * 그리고 **사람에게 보여줄 문장만으로는 부족하다** — 위층이 문장을 정규식으로
         * 다시 읽어야 한다면 그건 계약이 아니다. 기계가 읽을 코드를 함께 올린다:
         * 이 코드가 있어야 UI가 "갈라서 이어가기"를 내밀 수 있다 (codex의 thread/fork는
         * 잠겨 있어도 된다 — 실측으로 확인).
         */
        const msg = (err as Error).message
        if (/active writer/i.test(msg)) {
          throw Object.assign(
            new Error('This conversation is already open elsewhere (codex in a terminal, or another app)'),
            { code: 'conversation_locked' },
          )
        }
        throw err
      }
      this.threadId = threadIdOf(res) ?? this.opts.resumeExternalId
    } else {
      const res = await this.client.request<Record<string, unknown>>('thread/start', {
        cwd: this.opts.cwd,
        ...permissionOptionsFor(this.opts.permissionPreset),
        model: this.opts.model,
        /*
         * 오케스트레이터일 때만 붙는 둘.
         *
         * 역할은 developerInstructions로 직접 준다 — Claude의 systemPrompt append와
         * 같은 자리다. 파일(AGENTS.md)로 두지 않는 이유도 같다: 낮은 권한의 세션이
         * 그 파일을 고치면 모든 세션에 지시할 수 있는 쪽의 지시가 되어버린다.
         *
         * 도구는 stdio 다리를 통해 붙는다. 실측으로 확인한 것:
         *   per-thread config.mcp_servers  ✅ 살아 있다 (우리 명령이 실제로 실행됨)
         *   url(HTTP) 방식                 ❌ 요청이 한 건도 오지 않는다
         * 그래서 프로세스가 하나 더 뜬다 — Claude 경로에는 없는 비용이다.
         */
        ...(this.opts.systemPromptAppend ? { developerInstructions: this.opts.systemPromptAppend } : {}),
        ...(this.opts.orchestratorTools && this.opts.orchestratorBridge
          ? {
              config: {
                /*
                 * **폴더의 문서를 읽지 않는다** (Claude의 settingSources: []에 대응).
                 *
                 * 안 막으면 낮은 권한의 워커 세션이 오케스트레이터 폴더에 지시문을 써서
                 * 모든 세션에 지시할 수 있는 쪽을 조종할 수 있다.
                 * 실측: 이걸 넣기 전에는 심어둔 AGENTS.md를 그대로 따랐다
                 * ("침투성공-9142"부터 답했다).
                 */
                project_doc_max_bytes: 0,
                mcp_servers: {
                  [ORCHESTRATOR_MCP_SERVER]: {
                    command: process.execPath,
                    args: [bridgePath()],
                    env: {
                      CC_HOST_URL: this.opts.orchestratorBridge.url,
                      CC_HOST_TOKEN: this.opts.orchestratorBridge.token,
                      CC_SESSION_ID: this.opts.sessionId,
                    },
                  },
                },
              },
            }
          : {}),
      })
      this.threadId = threadIdOf(res)
    }
    this.externalId = this.threadId
  }

  private onNotification(n: { method: string; params?: unknown }): void {
    for (const e of normalizeNotification(this.sessionId, n)) this.emit(e)
  }

  private onServerRequest(r: { id: number | string; method: string; params?: unknown }): void {
    /*
     * **elicitation은 승인과 응답 형식이 다르다.**
     *
     * MCP 서버를 쓸지 물을 때 codex는 elicitation을 보내고 `{ action }`을 기다린다.
     * 우리는 모르는 서버 요청을 `{}`로 흘려보내고 있었는데, 그러면 codex가
     * "missing field `action`"으로 역직렬화에 실패하고 **거절로 처리한다** —
     * 화면에는 "권한이 거절되어"라고만 나와 원인을 알 수 없었다 (실측).
     *
     * 우리 서버는 받아들이고, 모르는 서버는 거절한다. 물어볼 화면이 없는데
     * 조용히 승낙하면 그건 사용자를 대신해 결정하는 것이다.
     */
    if (r.method.toLowerCase().includes('elicitation')) {
      const p = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as { serverName?: string }
      const ours = p.serverName === ORCHESTRATOR_MCP_SERVER
      this.client.respond(r.id, { action: ours ? 'accept' : 'decline', content: null, _meta: null })
      return
    }

    if (!r.method.includes('requestApproval') && !r.method.endsWith('Approval')) {
      // 승인이 아닌 서버 요청은 빈 응답으로 흘려보낸다 (프로토콜이 늘어나도 멈추지 않게)
      this.client.respond(r.id, {})
      return
    }
    const params = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as Record<string, unknown>

    /*
     * **우리 도구는 우리가 보증한다** (Claude 쪽 canUseTool과 같은 규칙).
     *
     * control_center 도구는 이 앱이 관리하는 세션 밖으로 나갈 수 없고, 진짜 위험한 일 —
     * 대상 세션이 무엇을 실행하는가 — 은 그 세션의 권한이 그대로 가른다.
     * 여기서 또 물으면 승인이 두 겹이 되고 "한 창에서 지시한다"가 무너진다.
     *
     * 실측: 이걸 안 하면 오케스트레이터가 "세션 목록 조회 요청이 승인되지 않아"라며
     * 첫 도구에서 멈춰 선다.
     */
    if (JSON.stringify(params).includes(`"${ORCHESTRATOR_MCP_SERVER}"`)) {
      this.client.respond(r.id, { decision: 'accept' })
      return
    }

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
      if (!this.threadId) throw new Error('Thread is not ready')
      return this.client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        /*
         * 추론 강도는 턴 단위로 넘긴다 — codex가 "이 턴과 이후 턴"에 적용한다고
         * 문서화한 자리다. 세션을 다시 띄우지 않고 바꿀 수 있어서 이쪽이 더 싸다.
         */
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
      })
    }).catch((e: Error) => {
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: { code: 'internal', message: e.message, retryable: true },
      })
    })
  }

  respondApproval(requestId: string, decision: ApprovalDecision, _scope?: ApprovalScope, matcher?: string): boolean {
    const serverId = this.approvals.get(requestId)
    // 스레드를 다시 띄우면 이 맵은 비어 있다 — 그 전에 뜬 카드의 id는 여기에 없다
    if (serverId === undefined) return false
    this.approvals.delete(requestId)

    if (decision === 'always' && matcher) this.alwaysAllow.add(matcher)
    this.client.respond(serverId, { decision: toCodexDecision(decision) })
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    return true
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
    if (!this.threadId) return
    // 실패를 삼키면 "멈췄겠지" 하고 기다리게 된다 — 안 멈췄으면 안 멈췄다고 말한다
    void this.client.request('turn/interrupt', { threadId: this.threadId }).catch((err: Error) => {
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: { code: 'internal', message: `Could not stop: ${err.message}`, retryable: true },
      })
    })
  }

  /** 매달린 승인을 말없이 놓지 않는다 (claude 어댑터와 같은 이유 — 화면이 카드를 붙든 채 막힌다) */
  async dispose(): Promise<void> {
    for (const requestId of this.approvals.keys()) {
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision: 'deny' })
    }
    this.approvals.clear()
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
        detail: loggedIn ? version : `${version} · login required`,
      }
    } catch {
      return {
        tool: 'codex',
        installed: false,
        loggedIn: false,
        detail: 'codex CLI not found (check with `which codex` in a terminal)',
      }
    }
  }

  listExternalSessions(cwd: string, limit: number) {
    return listCodexThreads(cwd, limit, whichTool('codex') ?? 'codex')
  }

  /**
   * 잠긴 대화에서 갈라져 나온다 (`thread/fork`).
   *
   * 사용량 조회와 같은 이유로 **단명 클라이언트**를 쓴다 — 이건 세션이 아니라
   * 세션을 만들기 **전에** 하는 일이라, 붙잡고 있을 스레드가 아직 없다.
   *
   * 원본은 건드리지 않는다. codex가 새 스레드에 `forkedFromId`로 출처를 남겨 준다.
   */
  async forkConversation(externalId: string, cwd: string): Promise<string> {
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
      { cwd, command: whichTool('codex') ?? 'codex' },
    )
    try {
      await client.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: null,
      })
      client.notify('initialized')
      const res = await client.request<Record<string, unknown>>('thread/fork', { threadId: externalId })
      const forked = threadIdOf(res)
      // 갈라졌다면서 새 id를 못 주면 이어갈 데가 없다 — 조용히 원본으로 되돌아가면 또 잠긴다
      if (!forked) throw new Error('codex forked the conversation but returned no thread id')
      return forked
    } finally {
      await client.dispose()
    }
  }

  /**
   * 계정 사용량 (FR-9).
   * 세션과 무관하므로 단명 클라이언트로 묻는다 — 대화 중인 스레드에 조회를 얹지 않는다.
   */
  async listUsage() {
    return readCodexUsage(whichTool('codex') ?? 'codex')
  }

  async listModels() {
    return listCodexModels(whichTool('codex') ?? 'codex')
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readCodexHistory(externalId, cwd, limit, whichTool('codex') ?? 'codex')
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const session = new CodexSession(opts, emit)
    // 스레드 id가 생겨야 재개가 가능하다 — 생성 시점에 확보한다 (M1.5 결함 5번 교훈)
    try {
      await session.ready
    } catch (err) {
      /*
       * 준비에 실패한 세션은 핸들이 밖으로 나가지 않는다 — dispose를 불러줄 사람이 없다.
       * 생성자에서 이미 뜬 app-server를 여기서 거두지 않으면, 잠긴 스레드를 이어가려다
       * 실패할 때마다 자식 프로세스가 하나씩 조용히 샜다.
       */
      await session.dispose().catch(() => {})
      throw err
    }
    return session
  }
}
