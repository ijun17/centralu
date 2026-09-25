import type { CallToolResult } from '@modelcontextprotocol/server'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import { z } from 'zod'
import type { BrokerCall, BrokerToolName } from './broker.js'
import {
  HOST_CAPABILITIES,
  capabilityKey,
  hostCapabilityText,
  isHostCapability,
  usesStamp,
  type Capability,
  type CapabilityBook,
  type HostCapability,
} from './capabilities.js'
import type { AppManifest } from './manifest.js'
import type { AppRef } from './ref.js'

/**
 * 중개 창구 (M4 D) — 앱이 fd 3으로 부탁한 것을 푸는 **한 자리**.
 *
 * 문지기(`broker.ts`)가 "이 파이프의 앱에 지금 열려 있는 실행"인지만 보고 넘기면, 여기서 부탁 하나를 끝까지 처리한다:
 * 매니페스트가 선언했나(`uses`), 무엇으로 풀까(도구마다의 몸통), 무엇을 돌려줄까. 선언은 허락이 아니다 — 선언하지
 * 않은 것은 몸통에 닿기 전에 거절한다(빠진 선언을 "전부"로 읽는 쪽이 위험하다, manifest.ts).
 *
 * 몸통 가운데 host의 코어가 해야 하는 것(에이전트 세션을 세운다)은 `BrokerHost`로 받는다. 런타임은 세션을 모른다
 * (`host-app-runtime-physics-only`) — 필요한 모양을 여기서 선언하고, 매니저가 런타임을 받을 때 채운다(`useExternalApps`).
 */

/** 부탁한 앱 — 파이프가 말해 준 앱과, 그 프로세스가 뜰 때 읽은 매니페스트 */
export type DeskApp = {
  ref: AppRef
  /** 사람이 읽는 이름(매니페스트의 `name`) */
  name: string
  manifest: AppManifest
}

/** 앱이 부탁한 에이전트 실행 하나 (D-1) — 창구가 선언과 도구를 확인한 뒤 host에 넘기는 모양 */
export type AgentRunRequest = {
  app: AppRef
  appName: string
  /** 창구가 고른 도구 — 매니페스트가 허락한 것 */
  tool: string
  prompt: string
  /** 답의 모양 (JSON Schema, 뿌리는 객체). 있으면 도구에 구조화 출력을 시킨다 */
  schema?: Record<string, unknown>
}

export type AgentRunResult = {
  /** 이 부탁을 받은 세션 — 요청마다 새로 선다 */
  sessionId: string
  /** 턴의 마지막 답(마지막 도구 호출 뒤의 글). 없으면 빈 글이다 */
  text: string
  /** 도구가 턴의 결말로 따로 준 구조화 출력(Claude) — 없으면 undefined(Codex는 마지막 글이 그 JSON이다) */
  output?: unknown
}

/**
 * 창구가 런타임에게 묻는 것 — 앱 목록과, 앱 도구를 부르는 단 하나의 길(`ExternalApps.call`). 창구가 런타임의 속을 들여다보지
 * 않게 이 둘만 받는다: 앱끼리의 호출(D-2)도 화면·세션의 호출과 같은 길(공개 범위·실행 id·취소·기록)을 지나야 한다.
 */
export type DeskApps = {
  /** 이 이름의 앱이 목록에 있나 — 틀린 매니페스트·신뢰하지 않은 프로젝트의 앱도 있다(부르면 그 이유로 거절된다) */
  has(ref: AppRef): boolean
  /** 사람이 읽는 앱 이름 — 매니페스트의 `name`, 없으면 id */
  name(ref: AppRef): string
  /**
   * 이 실행이 속한 사슬을 **누가 시작했나** (D-4) — 부모를 따라 올라가 앱이 아닌 첫 호출자. 세션이면 그 세션에, 화면이면
   * 그 앱의 고정 화면에 물음이 선다. 사슬을 더는 따라갈 수 없으면(부모가 이미 끝났다) null이다.
   */
  origin(runId: string): CapabilityOrigin | null
  call(
    ref: AppRef,
    tool: string,
    args: Record<string, unknown>,
    caller: { kind: 'app'; parentRunId: string },
    opts: { signal: AbortSignal },
  ): Promise<{ status: string; result: CallToolResult | null; error: string | null }>
}

/** 물음이 설 자리 — 사슬을 시작한 세션, 또는 사슬을 시작한 화면의 앱 */
export type CapabilityOrigin = { kind: 'session'; sessionId: string } | { kind: 'view'; app: AppRef }

/** 사람에게 묻는 것 하나 (D-4) — 창구가 만들어 host에 넘긴다 */
export type CapabilityQuestion = {
  /** 능력을 쓰려는 앱 */
  app: AppRef
  appName: string
  /** 기억의 열쇠 (`capabilityKey`) */
  capability: string
  /** 무엇을 하려는가 — "run an agent (Claude Code) in a new session" */
  text: string
  origin: CapabilityOrigin
  /** 이때까지 답이 없으면 창구가 거절로 닫는다 */
  expiresAt: number
}

/** 중개의 몸통 가운데 host의 코어가 채우는 것 */
export type BrokerHost = {
  /** 이 범위의 기본 에이전트 도구 — 프로젝트 앱이면 그 프로젝트의 기본 도구, 사용자 폴더 앱이면 오케스트레이터의 도구 */
  defaultAgentTool(projectId: string | null): string
  /**
   * 새 세션에 부탁을 보내고 턴이 끝나기를 기다린다. 신호가 서면 세션을 멈춘다(인터럽트). 도구를 쓸 수 없으면(설치·로그인)
   * 이유를 담아 던진다 — 그 이유가 곧 앱이 받는 말이다.
   */
  runAgent(req: AgentRunRequest, ctx: { signal: AbortSignal; progress(message: string): void }): Promise<AgentRunResult>
  /**
   * host 데이터 하나를 읽는다 (D-3). 창구가 이름(닫힌 목록)과 선언을 확인한 뒤에 부른다. 범위는 앱이 정한다: 프로젝트 앱은 그
   * 프로젝트, 사용자 폴더 앱은 사용자 전체. 줄 수 없으면(사용자 폴더 앱의 git.status) 이유를 담아 던진다.
   */
  hostData(name: HostCapability, app: AppRef): Promise<Record<string, unknown>>
  /** 에이전트 도구의 사람이 읽는 이름 — 물음에 적는다("Claude Code") */
  agentLabel(tool: string): string
  /**
   * 사람에게 묻는다 (D-4) — 세션에서 시작된 사슬이면 그 세션의 승인 카드로, 화면에서 시작된 사슬이면 그 앱의 고정 화면에.
   * 신호가 서면(시간이 지났다, 부탁이 취소됐다) 물음을 거두고 null로 끝낸다. 답을 기억하는 것은 창구의 일이다.
   */
  askCapability(q: CapabilityQuestion, signal: AbortSignal): Promise<'allow' | 'deny' | null>
}

/**
 * 부탁 한 번의 글 상한. 앱이 넘기는 글은 세션의 대화에 그대로 남고 매번 에이전트의 문맥을 채운다 — 이보다 긴 것은 글이
 * 아니라 자료이고, 자료는 파일로 넘길 일이다. 200,000자는 대략 5만 토큰으로 두 도구의 문맥 창 안쪽이다.
 */
export const AGENT_PROMPT_MAX_CHARS = 200_000
/** 스키마의 상한 — 답의 모양 하나를 적는 데 64KiB면 넉넉하다. 더 큰 것은 스키마가 아니라 자료다 */
export const AGENT_SCHEMA_MAX_BYTES = 64 * 1024

const CallAppArgs = z.object({
  app: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
})

/**
 * 앱이 부르는 다른 앱의 이름 → 앱 (D-2). 세션이 앱을 받는 규칙(결정 4)과 같은 모양이다: 프로젝트 앱은 **자기 프로젝트의
 * 앱을 먼저**, 없으면 사용자 폴더의 앱을 부른다. 사용자 폴더 앱은 사용자 폴더의 앱만 부른다 — 어느 프로젝트에도 속하지
 * 않으므로 한 프로젝트의 앱을 고를 근거가 없다. 다른 프로젝트의 앱은 이름이 같아도 닿지 않는다(프로젝트마다 신뢰가 다르다).
 */
export function resolveCallTarget(asker: AppRef, id: string, has: (ref: AppRef) => boolean): AppRef | null {
  if (asker.projectId !== null) {
    const same = { projectId: asker.projectId, appId: id }
    if (has(same)) return same
  }
  const user = { projectId: null, appId: id }
  return has(user) ? user : null
}

const HostDataArgs = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })

const RunAgentArgs = z.object({
  prompt: z.string(),
  tool: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
})

/** 기억된 답 하나의 보이는 모양 (`apps.permissions`) */
export type CapabilityDecisionListed = { capability: string; text: string; decision: 'allow' | 'deny'; decidedAt: number; current: boolean }

/** 거절의 이유 — 앱의 결과에도 앱의 표준에러에도 이 말이 간다. 되돌리는 길까지 적는다 */
function deniedText(tool: BrokerToolName, appName: string, text: string): string {
  return `${tool} refused: the person did not allow ${appName} to ${text}. They can change this in the app's Runs panel (Permissions → Forget), and Centralu asks again when the app's manifest changes what it uses.`
}

/** 사람이 읽을 길이 — "5 minutes", "1 second" */
function humanDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  return `${m} minute${m === 1 ? '' : 's'}`
}

const NOT_DECLARED = 'this app did not declare "uses": { "agent": … } in centralu.app.json — an app may run an agent only if its manifest says so'

const say = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })
const refuse = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

/**
 * 부탁한 도구와 선언을 맞춰 본다 (D-1). `true`는 사람의 기본 에이전트만, 목록은 목록에 적힌 도구만.
 * 도구를 안 적은 부탁은 기본 도구로 푼다 — 목록에 기본 도구가 없으면 목록의 첫 도구다(선언 밖으로 나가지 않는다).
 */
export function pickAgentTool(declared: boolean | string[] | undefined, requested: string | undefined, fallback: string): { tool: string } | { error: string } {
  if (declared === true) {
    if (requested !== undefined && requested !== fallback) {
      return {
        error:
          `this app declared "agent": true, which lets it use the person's default agent (${fallback}) only. ` +
          `To ask for ${requested} by name, list it in centralu.app.json: "uses": { "agent": ["${requested}"] }`,
      }
    }
    return { tool: fallback }
  }
  const list = Array.isArray(declared) ? declared : []
  if (list.length === 0) return { error: NOT_DECLARED }
  if (requested !== undefined) {
    return list.includes(requested) ? { tool: requested } : { error: `${requested} is not in this app's "uses.agent" (${list.join(', ')})` }
  }
  return { tool: list.includes(fallback) ? fallback : list[0]! }
}

export class BrokerDesk {
  private host: BrokerHost | null = null
  /**
   * 지금 사람에게 묻고 있는 것 — (앱, 능력)마다 하나. 같은 앱의 부탁 둘이 같은 능력을 동시에 쓰려 하면 물음은 하나만 선다
   * (둘째는 첫째의 답을 기다린다). 기다리는 쪽이 모두 떠나거나 시간이 지나면 물음을 거둔다.
   */
  private asking = new Map<string, { answer: Promise<'allow' | 'deny' | null>; waiters: number; withdraw: AbortController; timedOut: boolean }>()

  constructor(
    private apps: DeskApps,
    private book: CapabilityBook,
    /** 사람의 답을 기다리는 상한 (런타임의 timing — 시험이 줄인다) */
    private questionMs: () => number,
  ) {}

  /**
   * 답을 검증하는 JSON Schema 엔진 — MCP 서버 SDK가 도구의 outputSchema를 검증할 때 쓰는 것과 같은 것(ajv, 방언은
   * `$schema`로 고른다). 저장소에 새 의존을 들이지 않는다.
   */
  private schemas = new AjvJsonSchemaValidator()

  /** host의 코어가 몸통을 채운다 (`SessionManager.useExternalApps`). null이면 비운다 */
  attach(host: BrokerHost | null): void {
    this.host = host
  }

  async handle(app: DeskApp, tool: BrokerToolName, args: Record<string, unknown>, call: BrokerCall): Promise<CallToolResult> {
    switch (tool) {
      case 'run_agent':
        return this.runAgent(app, args, call)
      case 'call_app':
        return this.callApp(app, args, call)
      case 'host_data':
        return this.hostData(app, args, call)
    }
  }

  /**
   * `host_data` (D-3) — 닫힌 목록의 이름, 그리고 매니페스트가 `uses.host`에 적은 것만. 둘 다 기본은 거절이다: 목록 밖의 이름은
   * 없는 능력이고, 적지 않은 이름은 쓰지 않겠다고 한 능력이다. 답은 JSON 하나다(`structuredContent`와 같은 글).
   */
  private async hostData(app: DeskApp, raw: Record<string, unknown>, call: BrokerCall): Promise<CallToolResult> {
    const parsed = HostDataArgs.safeParse(raw)
    if (!parsed.success) return refuse(`host_data: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    const { name } = parsed.data
    if (!isHostCapability(name)) {
      return refuse(`host_data: Centralu has no host capability "${name}" — it can give: ${HOST_CAPABILITIES.join(', ')}`)
    }
    const declared = app.manifest.uses.host ?? []
    if (!declared.includes(name)) {
      return refuse(`host_data refused: "${name}" is not in this app's "uses.host" — declare it in centralu.app.json: "uses": { "host": ["${name}"] }`)
    }
    const host = this.host
    if (!host) return refuse('host_data is unavailable: this Centralu has no host data to give')
    const denied = await this.permit('host_data', app, { kind: 'host', name }, hostCapabilityText(name, app.ref.projectId === null ? 'user' : 'project'), call)
    if (denied) return denied
    const data = await host.hostData(name, app.ref)
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
  }

  /**
   * `run_agent` (D-1) — 선언 확인, 도구 고르기, 스키마 확인, 실행, 답 검증.
   *
   * **검증한 것이 곧 돌려주는 것이다.** 스키마를 준 부탁의 답은 도구가 이미 모양을 맞췄더라도(Claude는 CLI가 다시 시키고,
   * Codex는 디코딩을 묶는다) 여기서 한 번 더 같은 스키마로 검증한다. 앱은 이 답을 믿고 자기 상태에 쓴다 — 도구의 약속이
   * 아니라 우리가 확인한 것을 넘긴다.
   */
  private async runAgent(app: DeskApp, raw: Record<string, unknown>, call: BrokerCall): Promise<CallToolResult> {
    const parsed = RunAgentArgs.safeParse(raw)
    if (!parsed.success) return refuse(`run_agent: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    const { prompt, tool: requested, schema } = parsed.data
    if (!prompt.trim()) return refuse('run_agent needs a prompt')
    if (prompt.length > AGENT_PROMPT_MAX_CHARS) {
      return refuse(`run_agent: the prompt is ${prompt.length} characters, over the ${AGENT_PROMPT_MAX_CHARS} limit — pass large material as a file the agent can read`)
    }
    // 선언이 먼저다 — 선언하지 않은 앱은 host가 무엇을 빌려줄 수 있든 같은 이유로 거절된다
    const declared = app.manifest.uses.agent
    if (!declared || (Array.isArray(declared) && declared.length === 0)) return refuse(`run_agent refused: ${NOT_DECLARED}`)
    const host = this.host
    if (!host) return refuse('run_agent is unavailable: this Centralu has no agent sessions to lend')
    const picked = pickAgentTool(declared, requested, host.defaultAgentTool(app.ref.projectId))
    if ('error' in picked) return refuse(`run_agent refused: ${picked.error}`)

    let check: ((value: unknown) => string | null) | null = null
    if (schema) {
      const problem = this.schemaProblem(schema)
      if (problem) return refuse(`run_agent: ${problem}`)
      const validate = this.schemas.getValidator(schema as never)
      check = (value) => {
        const r = validate(value)
        return r.valid ? null : r.errorMessage
      }
    }

    const denied = await this.permit('run_agent', app, { kind: 'agent', tool: picked.tool }, `run an agent (${host.agentLabel(picked.tool)}) in a new session`, call)
    if (denied) return denied

    const r = await host.runAgent({ app: app.ref, appName: app.name, tool: picked.tool, prompt, ...(schema ? { schema } : {}) }, { signal: call.signal, progress: call.progress })
    if (!check) return say(r.text)

    const structured = r.output !== undefined ? r.output : parseJsonAnswer(r.text)
    const problem = structured === undefined ? 'the answer is not JSON' : check(structured)
    if (problem) {
      const seen = r.output !== undefined ? JSON.stringify(r.output) : r.text
      return refuse(
        `run_agent: the agent's answer does not match the schema (${problem}). ` +
          `The answer was: ${seen.length > 2000 ? `${seen.slice(0, 2000)}…` : seen || '(empty)'}`,
      )
    }
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured as Record<string, unknown> }
  }

  /**
   * `call_app` (D-2) — `uses.apps`에 적은 앱의 에이전트용(`model`) 도구만, 세션과 같은 범위 규칙으로.
   *
   * 부르는 것은 런타임의 한 길이다(호출자 `app`, 부모 = 이 부탁을 일으킨 실행). 그래서 공개 범위 검사(화면 전용 도구는
   * 거절), 신뢰·멈춘 앱의 거절, 실행 id, 기록이 다른 호출과 똑같이 일어나고, 부모 실행이 끝나거나 취소되면 이 호출도
   * 취소된다. 부른 앱의 답은 그대로 돌려준다 — 실패를 답했으면 실패인 채로.
   */
  private async callApp(app: DeskApp, raw: Record<string, unknown>, call: BrokerCall): Promise<CallToolResult> {
    const parsed = CallAppArgs.safeParse(raw)
    if (!parsed.success) return refuse(`call_app: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    const { app: id, tool, args } = parsed.data
    const listed = app.manifest.uses.apps ?? []
    if (!listed.includes(id)) {
      return refuse(
        `call_app refused: "${id}" is not in this app's "uses.apps"${listed.length ? ` (${listed.join(', ')})` : ''} — ` +
          'an app may call only the apps its manifest lists',
      )
    }
    const target = resolveCallTarget(app.ref, id, (r) => this.apps.has(r))
    if (!target) {
      return refuse(
        app.ref.projectId === null
          ? `call_app: there is no app "${id}" in your user folder — an app from the user folder can call only other apps there`
          : `call_app: there is no app "${id}" in this project or in your user folder`,
      )
    }
    const where = target.projectId === null && app.ref.projectId !== null ? ' from your user folder' : ''
    const denied = await this.permit('call_app', app, { kind: 'app', target }, `call the app "${this.apps.name(target)}"${where}`, call)
    if (denied) return denied
    const o = await this.apps.call(target, tool, args ?? {}, { kind: 'app', parentRunId: call.parentRunId }, { signal: call.signal })
    // 부른 앱이 답했다 — 답을 그대로(실패를 답했으면 실패인 채로)
    if (o.result) return o.status === 'ok' ? o.result : { ...o.result, isError: true }
    const how = o.status === 'cancelled' ? 'was cancelled' : o.status === 'rejected' ? 'was refused' : 'failed'
    return refuse(`call_app: ${id}.${tool} ${how} — ${o.error ?? 'no reason was given'}`)
  }

  /**
   * 능력 승인 (D-4) — 선언을 지난 부탁이 그 능력을 **처음** 쓸 때 사람에게 한 번 묻는다. 거절이면 앱에 돌려줄 결과를, 허락이면
   * null을 준다.
   *
   * 답은 (앱, 능력)마다 기억된다 — 허락도 거절도. 사람이 한 번 답한 것을 다시 묻지 않는다는 약속이고, 잘못 누른 답은 기록 판의
   * 목록에서 잊을 수 있다(`apps.forgetPermission`). 매니페스트의 `uses`가 바뀌면 지문이 달라져 기억한 답은 쓰이지 않는다 —
   * 앱을 만든 쪽이 무엇을 쓸지 다시 말했으니 사람도 다시 본다.
   *
   * 기다리는 동안 앱의 호출은 살아 있다(중개 통로의 진행 알림, `broker.ts`). 사람이 답하지 않고 상한(5분)이 지나면 거절로
   * 닫되 **기억하지 않는다** — 답이 아니다. 다음에 쓰려 할 때 다시 묻는다.
   */
  private async permit(tool: BrokerToolName, app: DeskApp, capability: Capability, text: string, call: BrokerCall): Promise<CallToolResult | null> {
    const key = capabilityKey(capability)
    const stamp = usesStamp(app.manifest.uses)
    const known = this.book.get(app.ref, key)
    if (known && known.stamp === stamp) return known.decision === 'allow' ? null : refuse(deniedText(tool, app.name, text))
    const host = this.host
    if (!host) return refuse('the broker is unavailable: there is no one to ask for permission')

    const slot = `${app.ref.projectId ?? '_user'}/${app.ref.appId} ${key}`
    let q = this.asking.get(slot)
    if (!q) {
      const withdraw = new AbortController()
      const expiresAt = Date.now() + this.questionMs()
      const entry = {
        answer: host.askCapability(
          { app: app.ref, appName: app.name, capability: key, text, origin: this.apps.origin(call.parentRunId) ?? { kind: 'view', app: app.ref }, expiresAt },
          withdraw.signal,
        ),
        waiters: 0,
        withdraw,
        timedOut: false,
      }
      const timer = setTimeout(() => {
        entry.timedOut = true
        withdraw.abort()
      }, expiresAt - Date.now())
      timer.unref?.()
      void entry.answer.finally(() => {
        clearTimeout(timer)
        if (this.asking.get(slot) === entry) this.asking.delete(slot)
      })
      this.asking.set(slot, entry)
      q = entry
    }
    const asked = q
    asked.waiters += 1
    call.progress(`waiting for the person to allow ${app.name} to ${text}`)
    let left = false
    const leave = () => {
      if (left) return
      left = true
      asked.waiters -= 1
      // 기다리는 쪽이 모두 떠났다 — 물을 까닭이 없다
      if (asked.waiters === 0) asked.withdraw.abort()
    }
    call.signal.addEventListener('abort', leave, { once: true })
    let answer: 'allow' | 'deny' | null
    try {
      answer = await Promise.race([
        asked.answer,
        new Promise<null>((resolve) => (call.signal.aborted ? resolve(null) : call.signal.addEventListener('abort', () => resolve(null), { once: true }))),
      ])
    } finally {
      call.signal.removeEventListener('abort', leave)
      leave()
    }
    if (call.signal.aborted) throw new Error('cancelled while waiting for the person')
    if (answer === null) {
      return refuse(
        asked.timedOut
          ? `${tool} refused: the person did not answer within ${humanDuration(this.questionMs())} whether ${app.name} may ${text}. Nothing was remembered — Centralu asks again next time.`
          : `${tool} refused: the question to the person was withdrawn before an answer`,
      )
    }
    // 답이 둘 이상의 기다림에 닿아도 기억은 한 번이면 된다 — 같은 값을 다시 적어도 해가 없다
    this.book.put(app.ref, { capability: key, text, decision: answer, stamp, decidedAt: Date.now() })
    return answer === 'allow' ? null : refuse(deniedText(tool, app.name, text))
  }

  /**
   * 한 앱에 대해 기억된 답 (D-4) — 기록 판이 보이고 잊게 한다. `current`는 지금 매니페스트의 선언과 같은 지문으로 답한 것인가다:
   * 아니면 그 답은 더 쓰이지 않는다(다시 묻는다).
   */
  permissions(ref: AppRef, manifestUses: unknown | null): (CapabilityDecisionListed)[] {
    const stamp = manifestUses === null ? null : usesStamp(manifestUses)
    return this.book
      .list(ref)
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .map((d) => ({ capability: d.capability, text: d.text, decision: d.decision, decidedAt: d.decidedAt, current: d.stamp === stamp }))
  }

  forgetPermission(ref: AppRef, capability: string): void {
    this.book.forget(ref, capability)
  }

  /**
   * 스키마를 받기 전에 보는 것. 뿌리가 객체여야 하는 이유: 답은 MCP 결과의 `structuredContent`로 가는데 그 칸은 객체다.
   * Codex의 구조화 출력(OpenAI 규칙)도 뿌리에 객체를 요구한다. 엔진이 읽지 못하는 스키마는 세션을 세우기 **전에**
   * 거절한다 — 세션을 세우고 도구를 한 턴 돌린 뒤에야 "스키마가 틀렸다"고 하면 사람의 사용량만 쓴다.
   */
  private schemaProblem(schema: Record<string, unknown>): string | null {
    const size = JSON.stringify(schema).length
    if (size > AGENT_SCHEMA_MAX_BYTES) return `the schema is ${size} bytes, over the ${AGENT_SCHEMA_MAX_BYTES} limit`
    if (schema.type !== 'object') return 'the schema must describe a JSON object at the top level ("type": "object")'
    try {
      this.schemas.getValidator(schema as never)
    } catch (e) {
      return `the schema is not a JSON Schema this host can read: ${(e as Error).message}`
    }
    return null
  }
}

/**
 * 마지막 글을 JSON으로 읽는다 — Codex는 스키마로 묶은 턴의 마지막 메시지 자체가 답이다. 코드 울타리(```json … ```)에
 * 싸여 와도 읽는다: 모델이 습관처럼 두르는 울타리 때문에 맞는 답을 버리지 않는다. 못 읽으면 undefined다.
 */
function parseJsonAnswer(text: string): unknown {
  const t = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t)
  try {
    return JSON.parse(fenced ? fenced[1]! : t)
  } catch {
    return undefined
  }
}
