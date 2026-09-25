import { z } from 'zod'
import { mcpServerNameError } from '../contract.js'

/**
 * 외부 앱의 매니페스트 `centralu.app.json` (M4 A-1).
 *
 * 앱 폴더 하나가 앱 하나이고, 이 파일이 그 폴더를 앱으로 만든다. 폴더의 나머지(서버 코드,
 * 화면)는 우리가 읽지 않는다 — 서버를 띄우는 명령과, 사람·에이전트에게 보일 이름과,
 * 앱이 무엇을 쓰겠다고 **선언**하는지만 여기서 정한다.
 *
 * 판정은 zod 한 벌이다. 규칙이 코드 여기저기의 if로 흩어지면 "어느 검사가 이 필드를
 * 보나"를 매번 찾아야 하고, 느슨한 쪽이 곧 구멍이다(#93에서 배운 것).
 */

export const MANIFEST_FILE = 'centralu.app.json'

/**
 * 이 Centralu가 읽을 줄 아는 매니페스트 판.
 *
 * 팀원끼리 Centralu 판이 다를 수 있어서 있는 칸이다(플랜 "앱 하나의 모양"). 모르는 판을
 * 추측으로 읽으면 뜻이 바뀐 필드를 옛 뜻으로 실행하게 된다 — 그래서 다르면 읽지 않고
 * "Centralu를 올려라"라고 말한다.
 */
export const MANIFEST_VERSION = 1

/**
 * 매니페스트 파일의 크기 상한. 설명 몇 줄과 목록 몇 개가 전부라 실제로는 1KiB 남짓이다.
 * 폴더 감시가 바뀔 때마다 다시 읽으므로, 누가 여기에 큰 파일을 두어도 host가 그걸 통째로
 * 메모리에 올리지 않게 한다.
 */
export const MAX_MANIFEST_BYTES = 64 * 1024

/**
 * 앱 안의 도구 이름 규칙. 어겼으면 사람이 읽을 이유를, 괜찮으면 null.
 *
 * `__`가 금지인 이유는 앱 id의 밑줄 금지와 같다(#93): 세션에서 도구 이름은
 * `mcp__app-<id>__<도구>`로 펼쳐지고 칸막이가 `__`다. 도구 이름에 `__`가 있으면 앱 하나가
 * 이름의 칸을 하나 더 만들어 남의 이름처럼 읽히게 할 수 있다.
 *
 * 도구 목록은 앱 서버가 실행 중에 말하는 것이라 매니페스트에는 없다 — 그래서 이 검사는
 * 목록을 읽는 자리(런타임)와 매니페스트의 `home`이 함께 쓴다.
 */
export function toolNameError(name: string): string | null {
  if (name.length === 0) return '도구 이름이 비어 있습니다'
  if (name.includes('__')) return `도구 이름에 "__"를 쓸 수 없습니다 (세션에서 도구 이름의 칸막이입니다): ${name}`
  return null
}

/**
 * 비밀 이름 = 앱 프로세스가 받을 환경 변수 이름.
 *
 * 우리가 앱에 넘기는 변수(`CENTRALU_APP_DATA` 등)와 host 자신의 변수(`CC_*`)는 비밀
 * 이름으로 가져갈 수 없다 — 사용자가 저장한 값이 데이터 폴더 경로를 덮어쓰면 앱이 남의
 * 폴더에 쓰게 된다.
 */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const RESERVED_ENV_PREFIXES = ['CENTRALU_', 'CC_'] as const

/** `uses.host`의 능력 이름 — 어휘는 D-3이 정한다. 지금은 모양만 본다 */
const HOST_CAPABILITY = /^[a-z][a-z0-9_.-]{0,63}$/

/**
 * `uses.agent`에 적는 도구 이름 (M4 D-1) — 어댑터의 이름(`claude`, `codex`)과 같은 모양이다. 어느 도구가 실제로 있는지는
 * 매니페스트가 알 수 없다(기계마다 다르다). 그래서 모양만 보고, 없는 도구는 부탁할 때 이유와 함께 거절한다.
 */
const AGENT_TOOL = /^[a-z][a-z0-9-]{0,31}$/

const appIdField = z.string().superRefine((id, ctx) => {
  const err = mcpServerNameError(id)
  if (err) ctx.addIssue({ code: 'custom', message: err })
})

const toolNameField = z.string().superRefine((name, ctx) => {
  const err = toolNameError(name)
  if (err) ctx.addIssue({ code: 'custom', message: err })
})

const secretNameField = z.string().superRefine((name, ctx) => {
  if (!SECRET_NAME.test(name)) {
    ctx.addIssue({ code: 'custom', message: `비밀 이름은 환경 변수 이름이어야 합니다 (대문자·숫자·밑줄): ${name}` })
  } else if (RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
    ctx.addIssue({ code: 'custom', message: `${RESERVED_ENV_PREFIXES.join('·')}로 시작하는 이름은 Centralu가 씁니다: ${name}` })
  }
})

/** 화면 CSP에 더할 출처들 — ext-apps의 `McpUiResourceCsp`와 같은 네 칸. 조립은 B-3이 한다 */
const CSP_KEYS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const
const cspField = z.object(Object.fromEntries(CSP_KEYS.map((k) => [k, z.array(z.string()).optional()])))

/**
 * 화면의 출처 방식 (B-3, 스파이크 S-1·S-8). `opaque`가 기본이다 — 안쪽 프레임에 출처가 없어서
 * 앱끼리 브라우저 저장소가 섞이지 않는다. `app`은 앱마다 고정된 포트의 진짜 출처를 달라는
 * **요청**이다. 브라우저 저장소나 blob 워커가 없으면 깨지는 앱(공개 앱 86개 중 5개, 지도 타일을
 * 못 받은 map-server)을 위한 문이다. 값은 ViewHost의 `OriginMode`와 같은 두 낱말이다.
 */
export const VIEW_ORIGINS = ['opaque', 'app'] as const
const VIEW_KEYS = ['origin'] as const

const USES_KEYS = ['agent', 'apps', 'host'] as const
const SERVER_KEYS = ['command', 'args'] as const

const ManifestSchema = z.object({
  manifestVersion: z.number().superRefine((v, ctx) => {
    if (v !== MANIFEST_VERSION) {
      ctx.addIssue({
        code: 'custom',
        message: `이 Centralu는 manifestVersion ${MANIFEST_VERSION}만 읽습니다 (받은 값: ${v}) — Centralu를 올리거나 앱을 만든 쪽과 판을 맞추세요`,
      })
    }
  }),
  id: appIdField,
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(2000),
  server: z.object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
  }),
  /** 고정 화면을 여는 도구(B-2) — 목록에 실제로 있는지는 서버가 떠야 안다 */
  home: toolNameField.optional(),
  /**
   * 앱이 **쓰겠다고 선언하는** 능력(D). 선언이지 허락이 아니다 — 허락은 처음 쓸 때 사람이
   * 한다(D-4). 없으면 아무것도 쓰지 않는 앱이다: 빠진 선언을 "전부"로 읽는 쪽이 위험하다.
   */
  uses: z
    .object({
      /**
       * 에이전트를 부탁할 수 있나 (D-1). `true`는 "사람의 기본 에이전트"다 — 프로젝트 앱이면 그 프로젝트의 기본 도구,
       * 사용자 폴더 앱이면 오케스트레이터의 도구. 도구를 골라 부탁하려면 목록으로 적는다(`["codex"]`): 목록에 없는 도구는
       * 거절한다. 선언이 좁을수록 사람이 허락할 것도 좁다(D-4는 도구마다 묻는다).
       */
      agent: z
        .union([
          z.boolean(),
          z.array(
            z.string().superRefine((t, ctx) => {
              if (!AGENT_TOOL.test(t)) ctx.addIssue({ code: 'custom', message: `에이전트 도구 이름의 모양이 아닙니다 (예: "claude", "codex"): ${t}` })
            }),
          ),
        ])
        .optional(),
      apps: z.array(appIdField).optional(),
      host: z
        .array(
          z.string().superRefine((h, ctx) => {
            if (!HOST_CAPABILITY.test(h)) ctx.addIssue({ code: 'custom', message: `호스트 능력 이름의 모양이 아닙니다: ${h}` })
          }),
        )
        .optional(),
    })
    .default({}),
  /** 이름만 적는다. 값은 사용자 기계에만 있다(런타임의 비밀 파일) */
  secrets: z.array(secretNameField).optional(),
  csp: cspField.optional(),
  /**
   * 화면을 어떻게 띄울지 (B-3). 없으면 불투명 출처다.
   *
   * 모르는 **값**은 거절한다(모르는 필드는 경고만 하는 것과 다르다). `"orgin": "app"` 같은 오타는
   * 경고로 남지만, `"origin": "per-app"`을 조용히 기본값으로 읽으면 작성자는 저장소가 왜 안 되는지
   * 알 길이 없다. 뜻을 모르는 값으로 앱을 띄우지 않는다는 manifestVersion의 규칙과 같은 쪽이다.
   */
  view: z.object({ origin: z.enum(VIEW_ORIGINS).default('opaque') }).optional(),
})

export type AppManifest = z.infer<typeof ManifestSchema>

export type ManifestResult =
  | { ok: true; manifest: AppManifest; warnings: string[] }
  | { ok: false; error: string; warnings: string[] }

/**
 * 매니페스트 원문 → 판정.
 *
 * **모르는 필드는 경고만 한다.** 새 Centralu가 더한 필드를 옛 Centralu가 만나면(팀원끼리
 * 판이 다를 때) 앱 전체를 거절하기보다, 아는 것만 읽고 모르는 것은 말해 두는 편이 맞다.
 * 뜻이 바뀌는 변경은 필드 추가가 아니라 manifestVersion을 올리는 것으로 한다.
 */
export function parseManifest(text: string): ManifestResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `${MANIFEST_FILE}가 JSON이 아닙니다: ${(e as Error).message}`, warnings: [] }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${MANIFEST_FILE}는 객체여야 합니다`, warnings: [] }
  }
  const warnings = unknownFields(raw as Record<string, unknown>)
  const parsed = ManifestSchema.safeParse(raw, { reportInput: true })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map(describeIssue).join('; '), warnings }
  }
  return { ok: true, manifest: parsed.data, warnings }
}

const TOP_KEYS = Object.keys(ManifestSchema.shape)

function unknownFields(raw: Record<string, unknown>): string[] {
  const out: string[] = []
  const check = (obj: unknown, known: readonly string[], prefix: string) => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) out.push(`모르는 필드는 무시합니다: ${prefix}${k}`)
    }
  }
  check(raw, TOP_KEYS, '')
  check(raw.server, SERVER_KEYS, 'server.')
  check(raw.uses, USES_KEYS, 'uses.')
  check(raw.csp, CSP_KEYS, 'csp.')
  check(raw.view, VIEW_KEYS, 'view.')
  return out
}

/** 사람과 만드는 에이전트가 읽을 한 줄 — 어느 칸이 왜 틀렸는가 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.') || '(전체)'
  if (issue.code === 'invalid_type' && issue.input === undefined) return `${path}: 빠졌습니다`
  return `${path}: ${issue.message}`
}
