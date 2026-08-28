# Agent Host — Node 사이드카 설계

> 영어 원본: [agent-host.md](agent-host.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

독립 실행되는 Node 프로세스다. dev에서는 개발자가 직접 띄우고(`pnpm host`), prod에서는 Tauri가 spawn하고 감시한다. **UI가 있든 없든 동일하게 동작해야 한다** — UI는 여러 번 닫혔다 다시 열릴 수 있고(재연결), 그동안 호스트는 세션을 계속 유지한다.

## 1. 내부 구조

```
agent-host/src/
├─ main.ts              # CLI(--port --token --dev-services), 기동 순서,
│                       #   그리고 도구 → 어댑터 레지스트리 (Map 리터럴. registry.ts는 없다)
├─ rpc.ts               # RPC 메서드 분배
├─ transport/
│  ├─ server.ts         # ws 서버, 핸드셰이크, RPC 라우팅
│  └─ event-log.ts      # seq 부여, 링 버퍼, afterSeq 재생 (protocol §1)
├─ adapters/
│  ├─ contract.ts       # AgentAdapter 인터페이스 + 능력 타입
│  ├─ claude/           # Claude Agent SDK 기반 (orchestrator-mcp.ts 포함)
│  └─ codex/            # app-server JSON-RPC 클라이언트 (직접 작성. stdio 다리 포함)
├─ sessions/            # 세션 수명, 오케스트레이터 도구, 앱 안내
├─ dev-services/        # git/fs/store (store는 dev 전용이 아니다 — 메시지가 사는 곳이다)
├─ log-file.ts          # stderr를 ~/.centralu/host.log로 흘린다 (stdout은 예약됨, 아래 참고)
├─ env-path.ts          # PATH 보강 — GUI 앱은 로그인 셸 PATH를 물려받지 못한다
├─ data-dir.ts          # 데이터 폴더 위치 판정과 이전
└─ updates.ts           # 업데이트 확인
```

사용량 파싱과 오케스트레이터의 MCP 표면은 **자기 디렉토리를 갖지 않는다**: 계정 사용량은
도구마다 다른 질문이라 `adapters/<tool>/usage.ts`에 있고, 오케스트레이터 도구는
`sessions/orchestrator-tools.ts`에 한 번 정의된 뒤 어댑터마다 다른 길로 노출된다 —
claude는 인프로세스, codex는 stdio 다리.

**stdout은 예약되어 있다.** `main.ts`가 딱 한 줄을 찍는다: Tauri 수퍼바이저가 포트와 인증
토큰을 읽어 가는 핸드셰이크다. 나머지는 전부 stderr로 간다. `log-file.ts`가 파일로 흘리는
것이 stderr이고, Finder로 띄운 `.app`의 stdout은 **닿는 곳이 아예 없기** 때문이다 — 그래서
이 패키지의 `console.log`는 터미널에서는 멀쩡해 보이면서 배포에서만 아무에게도 닿지 않는다.
`eslint.config.js`의 `no-console`이 그 한 줄만 빼고 전부 막는다.

## 2. AgentAdapter 계약 (product spec §6.2의 구현 명세)

```ts
interface AgentAdapter {
  readonly tool: ToolName                  // a closed enum in @cc/protocol — see #74
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>          // installed / logged in (FR-19)
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>
  resume(externalId: string, opts): Promise<SessionHandle | null>  // null = resume not possible
}

interface SessionHandle {
  readonly externalId: string
  send(input: UserInput): void
  respondApproval(requestId: string, decision: Decision, scope?: Scope): void
  interrupt(): void
  dispose(): Promise<void>
  events: Emitter<NormalizedEvent>         // emits protocol types only
}

interface AdapterCapabilities {
  approvals: boolean            // can permissions be overridden per session (reflects the M0 result)
  contextUsage: 'exact' | 'estimate' | 'none'
  resume: boolean
  autoTitle: boolean
  attachments: ('image' | 'file')[]
  verbosities: string[]         // 응답 길이 단계. 비어 있으면 이 도구에는 그 노브가 없다 (#54)
}
```

구현 규칙:

- **외부 SDK 타입은 adapters/<tool>/ 밖으로 나갈 수 없다** (anti-corruption). 어댑터의 유일한 출력은 `NormalizedEvent`다.
- 어댑터는 상태를 갖지 않는다 — 세션 상태 추적은 `sessions/`가 이벤트를 관찰하며 수행한다. 어댑터는 변환기일 뿐이다.
- 프로세스 관리(CLI spawn, 크래시 감지)는 어댑터 자신의 책임이다. 크래시는 `error` 이벤트로 방출되고 호스트는 죽지 않는다.
- capability는 반드시 정적 선언일 필요가 없다 — **detect() 시점에 결정**할 수도 있다 (예: 승인 동작 여부가 Codex 버전에 달려 있다면, 버전을 감지한 뒤 결정한다 — C4에 대한 대응).

## 3. 새 도구 추가 절차 (C3 — 이 문서가 존재하는 이유)

1. `adapters/<tool>/`을 만들고 `AgentAdapter`를 구현한다 (이벤트 변환 + detect + capability).
2. `@cc/protocol`의 `ToolName`에 도구를 넣고 `TOOL_META` 항목을 준다 — 표시 이름, 한 글자
   마크, 설치 명령, 로그인 명령. 그다음 `main.ts`의 `adapters` Map에 어댑터를 등록한다.
3. 계약 테스트를 추가한다: 녹화해 둔 raw 응답 픽스처 → NormalizedEvent 스냅샷 검증.
4. 의존하는 벤더 표면을 적어 두고 드리프트 체크를 만든다 (§3.1) —
   측정으로 얻은 프로토콜 지식은 그냥 두면 조용히 썩는다.
5. 끝. **ui, core, platform은 변경되지 않고**, protocol은 2번의 두 항목만큼만 바뀐다.
   (그 이상이 필요했다면 그것은 어댑터의 잘못이 아니라 프로토콜에 개념이 부족한 것이다 —
   프로토콜 확장을 먼저 검토한다)

이 문장은 예전에 더 셌고, 사실이 아니었다: protocol도 안 바뀐다고 적혀 있었지만 실제로 세
번째 도구를 넣으려면 11개 파일에 흩어진 약 20곳을 고쳐야 했다 — 따로 노는 `TOOL_LABEL` 맵
세 벌, 사이드바와 호스트의 인라인 `tool === 'codex' ? … : …` 삼항, 배지 글자, 설치·로그인
명령, 그리고 리터럴 `['claude', 'codex']` 배열 네 개. **동작** 쪽 경계는 언제나 깨끗했고
**표시** 쪽이 샜다. 이건 방향이 거꾸로다 — 새 도구의 비용이, 어댑터 디렉토리만 봐서는
존재조차 알 수 없는 잔손질로 청구된다는 뜻이기 때문이다. `TOOL_META`는 위 문장을 참으로
만들기 위해 있다 (#74).

**능력은 절대 `TOOL_META`에 넣지 않는다.** 도구가 *할 수 있는 것*은 어댑터가 선언하고
(`AdapterCapabilities`, `ModelOption`) 런타임에 발견된다. `TOOL_META`가 담는 것은 어떻게
보여줄지뿐이다. 둘을 섞는 순간 노브 하나를 UI에 두 번 가르쳐야 하는 코드가 된다.

### 3.1 벤더 표면 드리프트 체크 (SDK/CLI 업그레이드 전에 반드시 돌린다)

우리가 벤더 프로토콜에 대해 아는 것은 전부 측정으로 얻은 것이고, 벤더의 업그레이드는
그 지식을 **어디에도 에러를 내지 않고** 무효화할 수 있다. 그래서 어댑터마다 자기가
만지는 벤더 이름의 명시적 목록과, 그 목록을 재검증하는 스크립트를 둔다:

| 도구 | 계약 | 체크 | 잡는 것 |
|---|---|---|---|
| Codex | `adapters/codex/protocol-contract.json` — 우리가 보내거나 읽는 모든 RPC 메서드·알림, 승인 enum 값 | `pnpm codex:bindings --check` (설치된 CLI에서 바인딩을 재생성해 우리 이름을 대조) | 메서드/알림이 프로토콜에서 사라지는 것 (변경 축 C4) |
| Claude | `scripts/claude-sdk-drift.mjs` 안의 이름 목록 — SDK export, 옵션 키, 응답 필드, `resolvePermissionModeInCli` 같은 런타임 전용 이름 | `pnpm drift:claude` (`@latest`를 임시 폴더에 설치 — 워크스페이스는 건드리지 않는다) | 업그레이드가 우리에게 닿기 **전에** 이름이 `.d.ts`나 런타임에서 사라지는 것 |

둘 다 이름 검사이고, 양방향으로 돈다: 벤더는 우리가 쓰는 모든 이름을 여전히 갖고
있어야 하고, 우리 소스도 목록의 모든 이름을 여전히 써야 한다 (계약이 코드보다
오래 살아남지 못하게). 필드가 존재하되 뜻이 바뀌는 종류는 못 잡는다 — 그 종류는
어댑터의 런타임 타당성 검사가 지킨다 (컨텍스트 눈금 `149,084%`의 교훈).

**이 체크를 정직하게 유지하는 규칙:** 어댑터 코드가 새 벤더 이름 — 새 알림, config
키, 필드 — 에 의존하기 시작하면 **같은 PR에서** 계약에 추가한다. 새 도구(위 4단계)는
이 둘 중 하나에 해당하는 자기 몫을 만드는 것으로 시작한다.

## 4. 세션 생명주기와 UI 재연결

```
UI disconnects  → the host does nothing (sessions carry on, events accumulate in event-log)
UI reconnects   → hello → subscribe({ afterSeq }) → replay the missed events → restore the screen
host restarts   → session processes die → attempt resume with the externalId from the store
                  (the same path as FR-10)
```

이 설계 덕분에 FR-10의 절반(재시작 시 복원)은 평범한 재연결과 같은 코드 경로다 — 특별한 경우가 아니라 기본 동작이다.

## 5. dev-services (이름과 달리 prod 경로다 — 2026-08-15 정정)

M1.5에서 Node 사이드카가 배포 경로가 되면서, "Tauri 4단계에서 Rust로 옮기고 삭제한다"는 계획은
**보류되었다**. 이 디렉터리는 오늘날 prod에서 그대로 사용된다. 이름은 역사적 잔재다.

- **git**: `git` CLI spawn + `--porcelain=v2/-z` 파싱. status·diff·log·branches·checkout·stage·commit·push.
  git2(Rust)로의 이전은 **측정으로 병목이 확인되기 전까지는 하지 않는다** (m2-plan 결정 3).
  포트 인터페이스가 같으므로 나중에 옮겨도 UI는 변경되지 않는다.
- **store**: better-sqlite3 + `user_version` 마이그레이션 러너. 스키마 DDL은 정확히 한 곳,
  `protocol/src/schema/schema.sql`에만 있다. 번들에서는 빌드 산출물 옆에 복사되어 함께 배포된다 (F-0).
- **fs**: lazy readdir 목록 + `git check-ignore` (디렉터리당 1회) + 경로 이탈 차단.
- **attachments**: 붙여넣은 이미지를 `~/.centralu/attachments/<sessionId>/`에 저장한다.
- `--dev-services` 플래그는 **존재하지 않는다** (문서가 앞서 나갔다). 모든 것이 항상 로드된다.

## 6. 사용량과 한도 (FR-9)

**도구에게 묻는다. 도구의 파일을 읽지 않는다.** `agents.usage` → `SessionManager.usageFor(tool)`
→ 어댑터의 선택 메서드 `listUsage()`이고, 그 안에서 도구 자신의 API를 부른다 (한쪽은 Claude
SDK, 다른 쪽은 `app-server`). 답하지 못하는 어댑터는 던지고, 매니저가 이유를 달아 degrade한다 —
자신 있게 틀린 숫자를 보여주는 것보다 낫다.

사용량은 세션도 디렉토리도 아닌 **계정**의 성질이라 `listUsage()`에는 인자가 없다 — 어느
폴더에서 묻든 답이 같다. 다루는 것은 구독 한도뿐이고, 추가 결제(크레딧)는 범위 밖이다.

이 절은 원래 전혀 다른 것을 적고 있었다: chokidar로 `~/.claude/projects/**`와
`~/.codex/sessions/**`를 감시하며 증분 파싱하고, `usage_facts` 행을 써서 `usage.weekly` RPC로
읽고, 집계는 `core/usage`에서 한다는 설계. **그중 어느 것도 존재하지 않는다** — chokidar는
의존성이 아니고, `core/usage`라는 디렉토리는 없고, `usage.weekly` 메서드도 없으며,
`usage_facts`는 `schema.sql`에 남아 있지만 읽거나 쓰는 코드가 없다. 게다가 그것은 §8.1이
말하는 규칙의 **정반대**였고, 두 절이 이 문서 안에서 서로를 부정한 채 나란히 있었다. 도구의
비공개 JSONL을 읽는 것이 바로 §8.1이 금지하는 일이고, 이유도 거기 적혀 있다: 문서화되지 않은
포맷은 업그레이드에서 소리 없이 깨지며, 숫자가 조용히 깨지는 것은 숫자가 없는 것보다 나쁘다.

## 8. 이전 세션 가져오기 (외부 세션)

Centralu 밖에서 — 터미널에서 — 시작한 대화를 이어받는 경로다.
세션 생성 모달의 `+ → 도구 선택 → 이전 대화 목록`이 이 기능의 입구다.

### 8.1 원칙: 공식 API만 사용한다

두 도구 모두 트랜스크립트를 디스크에 남긴다
(`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`).
**우리는 그 파일을 직접 파싱하지 않는다.** 그 포맷은 문서화된 계약이 아니어서
도구가 업그레이드되면 소리 없이 깨지고, 깨진 줄도 모른 채 엉뚱한 대화를 보여주게 된다.

| | 목록 | 대화 읽기 |
|---|---|---|
| Claude Code | SDK `listSessions({ dir })` | SDK `getSessionMessages(id, { dir })` |
| Codex | app-server `thread/list { cwd }` | app-server `thread/read { threadId, includeTurns }` |

버전 호환의 책임은 도구 쪽에 있다 — 각 API는 자기 버전이 쓴 저장 포맷을 스스로 읽는다.
우리가 유지해야 하는 것은 **응답을 대화로 변환하는 부분**뿐이며, 그 변환은 도구를 띄우지 않고도
검증할 수 있도록 순수 함수로 분리되어 있다 (`adapters/history.test.ts`).

### 8.2 구버전 도구와의 호환

목록을 가져오지 못하는 것과 세션을 만들지 못하는 것은 다른 문제다.
**구버전 도구를 쓴다고 해서 새 세션 생성까지 막히지는 않는다.**

- Claude: dynamic import + 함수 존재 확인. 없으면 모듈 로드가 터지는 대신 '미지원'으로 처리한다.
- Codex: `thread/list`를 모르는 서버는 JSON-RPC `-32601`을 반환한다.
  이는 예외가 아니라 정상적인 협상 결과로 취급하고, 사유를 위로 전달한다.
  단, 진짜 장애(`EACCES` 등)는 '미지원' 뒤에 숨기지 않는다 — 원인이 보여야 한다.

그래서 `agents.listExternalSessions`는 throw하지 않고 `{ supported, reason?, sessions }`를 반환한다.
UI는 `supported: false`를 에러가 아니라 안내로 그린다.

### 8.3 대화 정리

두 도구 모두 사용자 턴에 자체 시스템 텍스트를 주입한다
(`<system-reminder>`, `<ide_opened_file>`, `<system_instruction>`, 슬래시 명령의 흔적).
실제로 목록 제목이 `<system_instruction>You are working inside…`로,
첫 대화가 `<ide_opened_file>…`로 나온 적이 있다.

`adapters/history-text.ts`는 이런 블록만 제거한다 — 전체를 버리지는 않는데,
주입된 블록 뒤에 진짜 사용자 발화가 이어지는 경우가 많기 때문이다.
제거하고 나서 아무것도 남지 않을 때만 그 줄을 버린다.
도구 호출과 결과는 이름만 남기고 버린다: 가져오기의 목적은 대화를 되찾는 것이지,
실행 로그를 되살리는 것이 아니다.

### 8.4 가져온 세션의 정체성

- 도구에는 `resume`을 보낸다 → 모델의 실제 컨텍스트가 이어진다.
- 화면은 마지막 `HISTORY_LIMIT`(200)줄을 복원한다 → 이것은 **표시용 스냅샷**이다.
- 복원된 대화는 `lastReadSeq = lastSeq`로 표시한다. 이미 읽은 대화 때문에 사람을 부르지 않는다.
- 어떤 대화를 이어받았는지는 `sessions.imported_from`(schema v5)에 기록한다.
  `external_id`로는 알 수 없다 — 도구가 resume 시 **새 식별자를 발급**해서
  원본과 달라질 수 있고, 그 순간 목록의 '이미 가져옴' 표시가 매번 틀리게 된다.
- 기록을 읽지 못해도 세션은 살아 있다. 기록을 못 읽었다는 이유로 대화까지 막을 이유는 없다.
