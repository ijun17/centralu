# Protocol — UI와 Agent Host의 공용 언어

> 영어 원본: [protocol.md](protocol.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

`packages/protocol`은 의존성 0개의 최하층 패키지다. **여기에 없는 타입은 프로세스 경계를 넘을 수 없다.**

## 1. 전송 계층

- WebSocket, 텍스트 프레임 1개 = JSON 메시지 1개.
- 연결 직후 핸드셰이크: `{ type: 'hello', token, protocolVersion }` → 불일치 시 즉시 종료(에러 코드와 함께). 토큰은 호스트가 시작될 때 생성되며, dev에서는 환경 변수로 전달된다.
- 방향에 따라 두 종류: **RPC**(요청/응답, UI→host)와 **이벤트 스트림**(host→UI, 단방향 푸시).

```ts
// envelope
type Rpc     = { kind: 'rpc';   id: string; method: string; params: unknown }
type RpcRes  = { kind: 'res';   id: string; ok: true; result: unknown }
             | { kind: 'res';   id: string; ok: false; error: ProtocolError }
type Push    = { kind: 'event'; seq: number; sessionId?: string; event: NormalizedEvent }
```

- `seq`는 호스트가 부여하는 단조 증가 번호다. 재연결 시 `subscribe({ afterSeq })`로 놓친 것을 재생한다 — **재연결이 상태 손실이 되지 않게 하는 핵심 장치다.**
- 호스트는 최근 이벤트를 링 버퍼(+ 스토어)에 보관한다. afterSeq가 버퍼 밖이면 `resync_required`를 보내고, UI는 스냅샷을 다시 로드한다.

## 2. NormalizedEvent (product spec §6.2의 구체화)

**정본 유니온은 `packages/protocol/src/events.ts`에 있다** — 모든 필드·기본값과
그렇게 정한 이유의 주석까지. 이 목록은 용도별로 묶은 지도다. 골든 픽스처 테스트
(`protocol.test.ts`)는 스키마에 있는 타입이 픽스처 없이 존재하는 순간 실패한다 —
스키마가 자기 예제보다 조용히 커질 수 없다.

```ts
type NormalizedEvent =
  // 대화 내용 (별도 표기가 없으면 seq로 영속된다)
  | { type: 'message_delta';    sessionId, role, text }         // 스트리밍 본문
  | { type: 'reasoning_delta';  sessionId, text?, estTokens? }  // #58: codex는 요약 텍스트, claude는 토큰 추정치뿐
  | { type: 'user_message';     sessionId, seq, text, from? }   // 사람의 말, 또는 다른 세션의 지시 (FR-11)
  | { type: 'tool_call';        sessionId, callId, summary: ToolSummary }
  | { type: 'tool_result';      sessionId, callId, ok, summary }
  | { type: 'message_image';    sessionId, mime, data, path?, note? }  // #40; 표시 실패의 이유는 note가 말한다
  | { type: 'compaction';       sessionId, failed, reason?, before?, after? }  // FR-14 마커
  // 턴 안의 진행 상황 (표시 전용, 영속되지 않는다)
  | { type: 'activity';         sessionId, activity|null }      // 압축 중 / 리뷰 중
  | { type: 'plan_update';      sessionId, steps: {text, status}[] }  // #58: codex turn/plan/updated 스냅샷
  | { type: 'tool_output_delta';sessionId, callId, text }       // #58: 실행 중 명령 출력의 꼬리
  // 사람이 답해야 하는 것
  | { type: 'approval_request'; sessionId, requestId, detail: ApprovalDetail }
  | { type: 'approval_resolved';sessionId, requestId, decision }
  | { type: 'question_request'; sessionId, requestId, questions: Question[] }  // AskUserQuestion
  | { type: 'question_resolved';sessionId, requestId }
  // 세션 상태와 계기판
  | { type: 'turn_complete';    sessionId }
  | { type: 'state_change';     sessionId, state: SessionState, reason? }
  | { type: 'usage_update';     sessionId, tokens: TokenUsage }
  | { type: 'context_update';   sessionId, used, window, exactness: 'exact'|'estimate' }
  | { type: 'limit_reached';    sessionId, resumeAt?, usedPercent?, windowMins? }
  | { type: 'session_title';    sessionId, title, auto }        // auto=false: 사람이 지은 이름 — 자동 이름이 덮지 않는다
  | { type: 'settings_changed'; sessionId, model, effort, verbosity, serviceTier? }  // #30: 사람 아닌 손이 설정을 바꿨다
  | { type: 'files_touched';    sessionId, paths: string[] }    // FR-2 충돌 감지, FR-5 하이라이트
  | { type: 'history_synced';   sessionId, added }              // 밖에서 이어간 대화를 따라잡았다
  | { type: 'session_deleted';  sessionId }
  // 앱 스코프 (sessionId optional — 모든 사실이 대화의 소유물은 아니다)
  | { type: 'update_status';    status: UpdateStatus }          // #43
  | { type: 'fs_changed';       projectId, dirs: string[] }     // #34
  | { type: 'error';            sessionId?, error: ProtocolError }
```

`ApprovalDetail`은 인라인 배너 승인(FR-3)의 판단에 필요한 것을 담도록 **어댑터가 미리 구조화**한다:

```ts
type ApprovalDetail =
  | { kind: 'command';   command: string; cwd: string }               // approvable from the banner
  | { kind: 'file_edit'; path: string; diffPreview: string; multi: boolean } // "needs review"
  | { kind: 'other';     raw: string }                                 // always "needs review"
```

판단 로직(core/approval)은 `kind`만으로 결정한다 — UI가 도구별 raw 포맷을 알 필요가 없도록 anti-corruption이 작동하는 실전 사례다.

## 3. RPC 메서드 (요약)

| 그룹 | 메서드 | 비고 |
|---|---|---|
| agents | `createSession, send, respondApproval, interrupt, archiveSession, resumeSession` | product spec §6.2 |
| git (dev) | `git.status, git.log, git.branches, git.diff, git.checkout` | prod에서는 같은 계약을 Tauri invoke로 |
| fs (dev) | `fs.listDir, fs.readFile, fs.watchProject` | 〃 |
| store (dev) | `store.loadWorkspace, store.saveWorkspace, store.appendMessages, …` | 〃 |
| usage | `usage.weekly(range)` | 호스트에 상주 |

git/fs/store RPC의 요청·응답 타입은 **포트 인터페이스와 1:1**이다. 의도된 중복이다 — 포트가 원본 계약이고, RPC와 Tauri invoke는 그 계약을 실어 나르는 두 운반체일 뿐이다.

## 3.1 경로를 표기하는 법 ([#47](https://github.com/ijun17/centralu/issues/47))

이 경계를 넘는 경로에는 두 종류가 있고, 둘은 같은 종류의 것이 아니다.

| 종류 | 예시 | 인코딩 |
|---|---|---|
| **프로젝트 상대 경로** | 모든 `fs` RPC의 `rel`, `FsEntry.path`, git의 파일 경로, 메시지가 링크하는 경로 | **항상 POSIX(`/`)**, 모든 호스트·모든 플랫폼에서 |
| **네이티브 경로** | `ProjectInfo.path` — 프로젝트의 디렉터리 | OS 고유 표기, **절대 분해하지 않고, 절대 정규화하지 않는다** |

**상대 경로를 정규화하는 이유.** `packages/ui`는 어느 OS 위에서 도는지 알 수 없게 되어 있다
([platform-abstraction.ko.md](platform-abstraction.ko.md) 참고; `tooling/styles.test.ts`가 강제한다).
상대 경로가 네이티브 구분자를 실어 나른다면 UI 안에서 Windows에서는 이렇게, 다른 곳에서는
저렇게 읽어야 하는데, 그것이 바로 그 규칙이 금지하는 분기다. git도 반대편에서 이를 확정한다:
git 자신의 경로 포맷은 모든 플랫폼에서 POSIX이고 그 출력은 그대로 화면에 도달하므로,
다른 선택을 하면 git의 답을 아무 이득 없이 변환해야 한다.

**절대 경로를 정규화하지 않는 이유.** 프로젝트 디렉터리는 OS 폴더 선택기로 고르고
그대로 OS에 되돌려준다 — 터미널의 cwd, 프로세스의 cwd, 파일 관리자. 아무것도 그것을
조작하지 않는다. 정규화는 이득 없이 손실만 낳는다: `C:\Users\me`에는 Windows가 다시
받아들일 POSIX 표기가 없다.

**변환이 일어나는 곳.** 상대 경로가 실제 파일시스템과 만나는 호스트의 가장자리,
그리고 그곳뿐이다. `@cc/protocol`의 `wireSegments` · `wireBaseName` · `wireJoin`이
구분자가 적혀 있는 유일한 곳이고, `osPathBaseName`은 다른 종류를 위한 것이다. macOS와
Linux에서는 이 변환이 항등이라서, 잘못해도 대가가 없었다 — 명문화되기 전까지는.

이것이 앱을 Windows에서 돌게 만드는 것은 **아니다** ([#14](https://github.com/ijun17/centralu/issues/14)).
그 전제 조건이다: 익명의 가정 스물한 개 대신 이름 붙은 가정 하나 — 그래서 Windows 빌드는
Windows에 관한 이유로만 실패한다. 스물두 번째 가정이 생기면 `tooling/paths.test.ts`가 빌드를 실패시킨다.

## 4. 스키마와 버전 규칙 (C6 방어)

- 모든 메시지는 zod 스키마로 정의되고 **경계에서만** 검증된다 (수신 시 1회. 내부 재검증은 금지 — 성능).
- `protocolVersion`은 단일 정수다. 호환 규칙:
  - **추가는 자유다** (새 이벤트 타입, 새 optional 필드) — 버전이 바뀌지 않는다.
  - 수신자는 **모르는 이벤트 타입과 필드를 반드시 무시해야 한다** (zod `passthrough` + discriminated union의 fallback case).
  - 필드 삭제나 의미 변경 = 버전 증가 = 핸드셰이크에서 거부. **가능한 한 피한다** — 새 필드를 추가하고 옛 필드를 한 마일스톤 동안 유지하는 편이 언제나 더 싸다.
- 골든 테스트: 버전별 샘플 메시지 JSON을 픽스처로 동결하고, 스키마가 바뀌면 과거 픽스처가 여전히 파싱되는지 CI가 검증한다.

## 5. 에러 모델

```ts
type ProtocolError = {
  code: 'adapter_crashed' | 'tool_not_installed' | 'not_logged_in'
      | 'session_not_found' | 'rate_limited' | 'version_mismatch' | 'internal'
  message: string          // a human-readable explanation (must be displayable in the UI as is)
  retryable: boolean
  data?: unknown           // extra information per code (rate_limited → resumeAt etc.)
}
```

- code는 닫힌 집합이다. UI는 code로 분기하고 message는 표시만 한다. 문자열 매칭 분기는 금지다.
- 어댑터의 raw 에러(SDK 예외, 프로세스 종료 코드)는 호스트 내부에서 이 형태로 변환된다.
