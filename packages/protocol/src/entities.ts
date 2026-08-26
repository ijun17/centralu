import { z } from 'zod'

/** 세션 상태 (product-spec FR-12). 긴급도는 core/session이 판정한다. */
export const SessionState = z.enum(['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error'])
export type SessionState = z.infer<typeof SessionState>

/**
 * 바쁜 동안 **무엇을 하느라** 바쁜가. SessionState와는 다른 축이다.
 *
 * 압축 중에도 상태는 여전히 'working'이다 — 나를 기다리는 게 아니니 바꿀 이유가 없고,
 * 상태를 늘리면 `state === 'working'`을 보는 모든 코드가 조용히 틀리게 된다.
 * 그런데 화면만 보면 답을 만드는 중과 구분이 안 된다: 둘 다 점만 깜빡인다.
 * 실측으로 수동 압축 한 번이 39초 걸렸다 — 그동안 멈춘 건지 일하는 건지 알 방법이 없었다.
 */
/** 바쁨의 종류. compacting은 양쪽 다, reviewing은 codex의 /review(전용 RPC)가 낸다 */
export const SessionActivity = z.enum(['compacting', 'reviewing'])
export type SessionActivity = z.infer<typeof SessionActivity>

export const ToolName = z.enum(['claude', 'codex'])
export type ToolName = z.infer<typeof ToolName>

/** 권한 프리셋 — CLI 전역 설정을 세션 단위로 덮어쓴다 (M0 검증 완료) */
export const PermissionPreset = z.enum(['safe', 'normal', 'auto'])
export type PermissionPreset = z.infer<typeof PermissionPreset>

export const ApprovalDecision = z.enum(['allow', 'deny', 'always'])
export type ApprovalDecision = z.infer<typeof ApprovalDecision>

export const ApprovalScope = z.enum(['session', 'project'])
export type ApprovalScope = z.infer<typeof ApprovalScope>

/**
 * 승인 요청 상세. 어댑터가 도구별 원시 형식을 이 3종으로 정규화한다.
 * core/approval은 kind만 보고 배너 제자리 승인 가능 여부를 판정한다 (FR-3).
 */
export const ApprovalDetail = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: z.string(), cwd: z.string() }),
  z.object({
    kind: z.literal('file_edit'),
    path: z.string(),
    diffPreview: z.string(),
    multi: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('other'), raw: z.string() }),
])
export type ApprovalDetail = z.infer<typeof ApprovalDetail>

/**
 * 에이전트가 사람에게 내미는 선택지 (AskUserQuestion).
 *
 * **자르지 않는다.** 도그푸딩에서 이 도구 호출이 원시 JSON으로 흐르다 중간에 잘려
 * 두 번째 선택지부터 보이지 않았다 — 답할 수단이 통째로 사라진 것이다.
 * 승인(ApprovalDetail)과 달리 여기엔 미리보기가 아니라 **답에 필요한 전부**가 담긴다.
 */
export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().default(''),
})
export type QuestionOption = z.infer<typeof QuestionOption>

export const Question = z.object({
  question: z.string(),
  /** 짧은 꼬리표 (최대 12자 권장) */
  header: z.string().default(''),
  options: z.array(QuestionOption),
  multiSelect: z.boolean().default(false),
})
export type Question = z.infer<typeof Question>

/** 한 질문에 대한 답 — 고른 라벨들 (multiSelect면 여럿, 자유 입력이면 그 텍스트) */
export const QuestionAnswer = z.object({
  question: z.string(),
  answers: z.array(z.string()),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

export const ToolSummary = z.object({
  tool: z.string(),
  /** 한 줄 요약 (명령 전문, 파일 경로 등) */
  title: z.string(),
  /** 조회성 도구는 UI에서 기본 접힘 (FR-3 접힘 정책) */
  readOnly: z.boolean().default(false),
  paths: z.array(z.string()).default([]),
})
export type ToolSummary = z.infer<typeof ToolSummary>

export const TokenUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  costUsd: z.number().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsage>

/**
 * 어댑터 능력 선언 — UI는 이걸 보고 기능을 활성/비활성 (architecture §6.2).
 *
 * **선택 메서드로 알 수 있는 것은 여기 넣지 않는다.** 플래그와 구현이 어긋날 수 있기 때문이다:
 * 예전에 listExternal 플래그가 있었는데, true인데 메서드가 없으면 조용히 아무 일도 안 했다.
 * "할 수 있나?"의 답은 하나여야 한다 → 메서드가 있으면 할 수 있다.
 * 여기 남은 것들은 메서드로 표현되지 않는 성질(승인 지원 여부, 컨텍스트 정확도 등)뿐이다.
 */
export const AdapterCapabilities = z.object({
  approvals: z.boolean(),
  contextUsage: z.enum(['exact', 'estimate', 'none']),
  resume: z.boolean(),
  autoTitle: z.boolean(),
  attachments: z.array(z.enum(['image', 'file'])).default([]),
  /**
   * 응답 길이(verbosity) 단계. 비어 있으면 이 도구에는 그 노브가 없다 (#54).
   *
   * 모델에 붙이지 않고 여기 두는 이유: codex의 `model/list`는 모델별 verbosity를
   * 알려주지 않는다 (generated/v2/Model.ts에 그 필드가 없다 — 실측).
   * 모델에 붙이려면 우리가 지어내야 하는데, 그 순간 목록 하드코딩 금지 규칙이 깨진다.
   * 도구 단위 성질은 어댑터 능력 선언이 맞는 자리다.
   */
  verbosities: z.array(z.string()).default([]),
})
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>

export const ProtocolErrorCode = z.enum([
  'adapter_crashed',
  'tool_not_installed',
  'not_logged_in',
  'session_not_found',
  'rate_limited',
  'version_mismatch',
  'internal',
])
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>

export const ProtocolError = z.object({
  code: ProtocolErrorCode,
  /** 사람이 읽는 설명 — UI가 그대로 표시 가능해야 한다 */
  message: z.string(),
  retryable: z.boolean().default(false),
  data: z.unknown().optional(),
})
export type ProtocolError = z.infer<typeof ProtocolError>

/** 깃 패널 (FR-4) */
export const GitFileStatus = z.object({
  path: z.string(),
  staged: z.boolean(),
  status: z.enum(['M', 'A', 'D', 'R', 'U', '?']),
})
export type GitFileStatus = z.infer<typeof GitFileStatus>

export const GitCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  author: z.string(),
  when: z.number(),
  parents: z.array(z.string()),
  /**
   * 이 커밋을 만든 세션 이름 (#50). 훅이 아니라 관찰로 안다 — 에이전트의
   * `git commit` 도구 호출에서 해시를 주워 우리 DB에만 적는다. 사람이 직접 한
   * 커밋에는 없다 — 그게 정확한 것이다.
   */
  sessionName: z.string().optional(),
})
export type GitCommit = z.infer<typeof GitCommit>

/**
 * 고를 수 있는 모델 한 종류.
 *
 * **목록을 우리가 적지 않는다.** 도구가 공식 API로 알려주는 것을 그대로 나른다
 * (Claude: `supportedModels()`, Codex: `model/list`).
 * 하드코딩하면 새 모델이 나올 때마다 이 앱이 조용히 뒤처진다 —
 * 실제로 Fable이 나왔는데 목록에 없어서 고를 수 없었다.
 *
 * 추론 강도도 모델마다 지원 여부와 단계가 다르므로 모델에 붙여서 온다.
 * 별도 플래그로 두면 "이 모델이 지원하나?"의 답이 둘이 되어 어긋난다.
 */
export const ModelOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** 이 모델이 지원하는 추론 강도. 비어 있으면 강도 선택이 없는 모델이다 */
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
})
export type ModelOption = z.infer<typeof ModelOption>

export const GitBranch = z.object({
  name: z.string(),
  current: z.boolean(),
  remote: z.boolean(),
  upstream: z.string().optional(),
})
export type GitBranch = z.infer<typeof GitBranch>

export const GitDiff = z.object({ diff: z.string(), truncated: z.boolean(), binary: z.boolean() })
export type GitDiff = z.infer<typeof GitDiff>

/**
 * 첨부 (FR-13).
 * 이미지는 base64로 messages.payload에 넣지 않는다 — DB가 비대해지고 FTS가 오염된다.
 * host가 파일로 저장하고 경로만 주고받는다 (m2-plan D-1 결정).
 */
export const Attachment = z.object({
  kind: z.enum(['image', 'file']),
  /** 프로젝트 내 파일이면 상대 경로, 붙여넣은 이미지면 저장된 절대 경로 */
  path: z.string(),
  name: z.string(),
  mime: z.string().optional(),
  bytes: z.number().optional(),
})
export type Attachment = z.infer<typeof Attachment>

/**
 * 도구가 자체적으로 보관 중인 이전 세션 (Centralu 밖 — 터미널에서 만든 것 포함).
 *
 * 목록도 본문도 **각 도구의 공식 API로만** 읽는다.
 * ~/.claude/projects/**.jsonl 이나 ~/.codex/sessions/**.jsonl 을 직접 파싱하지 않는다:
 * 그 파일 포맷은 문서화된 계약이 아니라서 도구가 올라가면 소리 없이 깨진다.
 * 공식 API는 자기 버전의 저장 포맷 차이를 스스로 흡수한다.
 */
export const ExternalSession = z.object({
  externalId: z.string(),
  tool: ToolName,
  title: z.string(),
  updatedAt: z.number(),
  createdAt: z.number().nullable().default(null),
  branch: z.string().nullable().default(null),
  /** 이미 Centralu로 불러온 세션 — 같은 대화를 두 번 열지 않게 한다 */
  imported: z.boolean().default(false),
  /**
   * 이미 열려 있다면 **그 세션의 id**.
   *
   * 표시만으로는 부족하다 — 예전에는 '이미 불러옴'이라고 써 두고도 클릭은 그대로 돼서
   * 같은 대화가 목록에 둘 생겼다 (실측으로 확인). UI는 이 값이 있으면 새로 만들지 않고
   * 그 세션으로 데려간다.
   */
  importedAs: z.string().nullable().default(null),
})
export type ExternalSession = z.infer<typeof ExternalSession>

/**
 * 사용량 스냅샷 — **계정 단위**다 (세션·디렉토리와 무관).
 *
 * 도구마다 창의 개수와 이름이 다르므로 배열로 받는다:
 *   Claude — session(5시간) · weekly_all · weekly_scoped
 *   Codex  — primary(10080분=주간) · secondary
 * UI는 창이 몇 개인지 모르는 채로 그린다. 새 창이 생겨도 화면을 고치지 않는다.
 */
export const UsageWindow = z.object({
  id: z.string(),
  label: z.string(),
  /** 0~100. 한도 대비 얼마나 썼나 */
  percent: z.number(),
  /** 창이 언제 초기화되나 (ISO). 모르면 null */
  resetsAt: z.string().nullable().default(null),
  /** 특정 모델에만 걸리는 창이면 그 이름 */
  scope: z.string().nullable().default(null),
})
export type UsageWindow = z.infer<typeof UsageWindow>

export const UsageSnapshot = z.object({
  plan: z.string().nullable().default(null),
  windows: z.array(UsageWindow).default([]),
  /** 일별 토큰. 못 주는 도구는 비운다 — UI가 알아서 그 줄을 접는다 */
  daily: z.array(z.object({ date: z.string(), tokens: z.number() })).default([]),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshot>

/**
 * Where this install stands against the registry (issue #43).
 *
 * **One shape carries both the answer and what we are doing about it.** The check and
 * the update are two steps of one errand ("am I behind, and can I stop being behind"),
 * and the screen shows one line for the whole errand — splitting them would force the
 * UI to stitch two facts back together and to invent what to show when they disagree.
 *
 * The host owns every field here; nothing on this list is decided on the UI side.
 */
export const UpdateStatus = z.object({
  /** The running build's version — `APP_VERSION`, the value this app was built from */
  current: z.string(),
  /**
   * What the registry's `latest` tag points at, or null until a check has succeeded.
   *
   * Null is not "up to date". A check that never reached the network must not read as
   * good news — that mistake is what let #42 hide for a whole release.
   */
  latest: z.string().nullable().default(null),
  /** `latest` outranks `current`, by the comparison the launcher ships (`isNewerVersion`) */
  newer: z.boolean().default(false),
  /** Whether the host re-checks on its own schedule. Settings turns this on and off */
  auto: z.boolean().default(true),
  /**
   * What the update is doing right now.
   *
   * `restart_required` is a terminal state on purpose: the new version is on disk and
   * the running process is still the old one. **The app never restarts itself** —
   * replacing a running program out from under someone mid-turn is the kind of quiet
   * irreversible act this app does not do.
   */
  phase: z.enum(['idle', 'checking', 'updating', 'restart_required', 'failed']).default('idle'),
  /**
   * Why the last check or update did not work, or null when nothing went wrong.
   *
   * A failed *check* is swallowed everywhere it matters (it never breaks startup and
   * never interrupts) but it is still recorded here, because "Check now" that answers
   * with nothing at all is indistinguishable from a button that does nothing.
   */
  error: z.string().nullable().default(null),
  /** When the last successful check finished (epoch ms), or null if none ever has */
  checkedAt: z.number().nullable().default(null),
})
export type UpdateStatus = z.infer<typeof UpdateStatus>
