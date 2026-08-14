# Agent Host — Node 사이드카 설계

단독 실행 가능한 Node 프로세스. dev에선 개발자가 직접 띄우고(`pnpm host`), prod에선 Tauri가 spawn·감시한다. **UI가 있든 없든 동작이 같아야 한다** — UI는 여러 번 껐다 켜져도(재연결) host는 세션을 유지한다.

## 1. 내부 구조

```
agent-host/src/
├─ main.ts              # CLI: --port --token --dev-services
├─ transport/
│  ├─ server.ts         # ws 서버, 핸드셰이크, RPC 라우팅
│  └─ event-log.ts      # seq 부여, 링 버퍼, afterSeq 재전송 (protocol §1)
├─ adapters/
│  ├─ contract.ts       # AgentAdapter 인터페이스 + capability 타입
│  ├─ claude/           # Claude Agent SDK 기반
│  ├─ codex/            # app-server JSON-RPC 클라이언트 (자작)
│  └─ registry.ts       # 도구명 → 어댑터 팩토리, 설치/로그인 감지
├─ sessions/            # 세션 수명주기 관리 (어댑터 위에서 상태 追跡)
├─ dev-services/        # dev 전용 git/fs/store — Tauri 전환 시 단계적 삭제
├─ usage/               # ~/.claude, ~/.codex JSONL 증분 파서 (상주)
└─ mcp/                 # 오케스트레이터용 MCP 서버 (M3)
```

## 2. AgentAdapter 계약 (기획서 §6.2의 구현 사양)

```ts
interface AgentAdapter {
  readonly tool: 'claude' | 'codex' | string
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>          // 설치·로그인 여부 (FR-19)
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>
  resume(externalId: string, opts): Promise<SessionHandle | null>  // null = resume 불가
}

interface SessionHandle {
  readonly externalId: string
  send(input: UserInput): void
  respondApproval(requestId: string, decision: Decision, scope?: Scope): void
  interrupt(): void
  dispose(): Promise<void>
  events: Emitter<NormalizedEvent>         // protocol 타입만 방출
}

interface AdapterCapabilities {
  approvals: boolean            // 세션 단위 권한 오버라이드 가능 여부 (M0 검증 결과 반영)
  contextUsage: 'exact' | 'estimate' | 'none'
  resume: boolean
  autoTitle: boolean
  attachments: ('image' | 'file')[]
}
```

구현 규칙:

- **외부 SDK 타입은 adapters/<tool>/ 밖으로 나올 수 없다** (anti-corruption). 어댑터의 유일한 출력은 `NormalizedEvent`.
- 어댑터는 상태를 갖지 않는다 — 세션 상태 추적은 `sessions/`가 이벤트를 보고 한다. 어댑터는 변환기다.
- 프로세스 관리(CLI spawn, 크래시 감지)는 어댑터 내부 책임. 크래시는 `error` 이벤트로 방출하고 host는 죽지 않는다.
- capability는 정적 선언이 아니라 **detect() 시점에 결정**될 수 있다 (예: Codex 버전에 따라 approvals 여부가 다르면 버전 감지 후 결정 — C4 대응).

## 3. 새 도구 추가 절차 (C3 — 이 문서의 존재 이유)

1. `adapters/<tool>/` 생성, `AgentAdapter` 구현 (이벤트 변환 + detect + capability).
2. `registry.ts`에 팩토리 등록.
3. 계약 테스트 추가: 녹화된 원시 응답 픽스처 → NormalizedEvent 스냅샷 검증.
4. 끝. **ui·core·protocol·platform은 변경 없음.** (변경이 필요했다면 그건 어댑터가 아니라 protocol에 개념이 없는 것 — protocol 확장을 먼저 검토)

## 4. 세션 수명주기와 UI 재연결

```
UI 연결 끊김 → host는 아무것도 안 함 (세션 계속 진행, 이벤트는 event-log에 적재)
UI 재연결   → hello → subscribe({ afterSeq }) → 유실 이벤트 재생 → 화면 복원
host 재시작 → 세션 프로세스 소멸 → store의 externalId로 resume 시도 (FR-10 경로와 동일)
```

이 설계 덕에 FR-10(재시작 복원)의 절반은 "일반 재연결"과 같은 코드 경로다 — 특수 케이스가 아니라 기본 동작.

## 5. dev-services (수명이 정해진 코드)

- git: `git` CLI spawn + `--porcelain=v2` 파싱. **의도적으로 얇게** — Tauri 전환 4단계(platform-abstraction §5)에서 삭제된다.
- store: better-sqlite3. 스키마 DDL은 `protocol/schema.sql`에 버전과 함께 두고 Rust 구현과 공유한다 (같은 파일을 읽는다 — 스키마 이중 정의 금지).
- fs: readdir lazy 목록 + chokidar 워치.
- `--dev-services` 플래그가 없으면 이 모듈들은 로드조차 되지 않는다 (prod host는 어댑터+usage+mcp만).

## 6. usage 파서

- chokidar로 `~/.claude/projects/**`, `~/.codex/sessions/**` 감시, **증분 파싱** (파일별 오프셋 저장).
- 집계 결과는 store에 `usage_facts`로 적재, UI는 `usage.weekly` RPC로 조회.
- 파싱(IO·포맷 지식)은 여기, 집계 계산(주간 합산·비용 추정)은 `core/usage` — 로그 포맷이 바뀌어도 계산 로직은 무사하다.
