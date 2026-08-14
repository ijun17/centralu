# 프로토콜 — UI와 Agent Host의 공용어

`packages/protocol`은 의존이 0인 최하층 패키지다. **여기 없는 타입으로는 프로세스 경계를 넘을 수 없다.**

## 1. 전송 계층

- WebSocket, 텍스트 프레임 1개 = JSON 메시지 1개.
- 연결 직후 핸드셰이크: `{ type: 'hello', token, protocolVersion }` → 불일치 시 즉시 종료(에러 코드 포함). 토큰은 host 기동 시 생성, dev에선 환경변수로 전달.
- 방향별 두 종류: **RPC**(요청/응답, UI→host)와 **이벤트 스트림**(host→UI, 단방향 push).

```ts
// 봉투 (envelope)
type Rpc     = { kind: 'rpc';   id: string; method: string; params: unknown }
type RpcRes  = { kind: 'res';   id: string; ok: true; result: unknown }
             | { kind: 'res';   id: string; ok: false; error: ProtocolError }
type Push    = { kind: 'event'; seq: number; sessionId?: string; event: NormalizedEvent }
```

- `seq`는 host가 부여하는 단조 증가 번호. 재연결 시 `subscribe({ afterSeq })`로 유실분 재전송 — **재연결이 상태 유실이 되지 않게 하는 핵심 장치.**
- host는 최근 이벤트를 링 버퍼(+store)에 보관한다. afterSeq가 버퍼 밖이면 `resync_required`를 보내고 UI는 스냅샷 재로드.

## 2. NormalizedEvent (기획서 §6.2의 구체화)

```ts
type NormalizedEvent =
  | { type: 'message_delta';    sessionId, role, text }         // 스트리밍 본문
  | { type: 'tool_call';        sessionId, callId, tool, summary: ToolSummary }
  | { type: 'tool_result';      sessionId, callId, ok, summary }
  | { type: 'approval_request'; sessionId, requestId, detail: ApprovalDetail }
  | { type: 'approval_resolved';sessionId, requestId, decision }
  | { type: 'turn_complete';    sessionId }
  | { type: 'state_change';     sessionId, state: SessionState, reason? }
  | { type: 'usage_update';     sessionId, tokens: TokenUsage }
  | { type: 'context_update';   sessionId, used, window, exactness: 'exact'|'estimate' }
  | { type: 'limit_reached';    sessionId, resumeAt?: string }
  | { type: 'session_title';    sessionId, title }
  | { type: 'files_touched';    sessionId, paths: string[] }    // FR-2 충돌 감지·FR-5 하이라이트용
  | { type: 'error';            sessionId?, error: ProtocolError }
```

`ApprovalDetail`은 배너 제자리 승인 판단(FR-3)에 필요한 정보를 **어댑터가 미리 구조화**해서 보낸다:

```ts
type ApprovalDetail =
  | { kind: 'command';   command: string; cwd: string }               // 배너 승인 가능
  | { kind: 'file_edit'; path: string; diffPreview: string; multi: boolean } // "확인 필요"
  | { kind: 'other';     raw: string }                                 // 항상 "확인 필요"
```

판단 로직(core/approval)은 `kind`만 보고 결정한다 — 도구별 원시 형식을 UI가 알 필요가 없게 하는 anti-corruption의 실례.

## 3. RPC 메서드 (요약)

| 그룹 | 메서드 | 비고 |
|---|---|---|
| agents | `createSession, send, respondApproval, interrupt, archiveSession, resumeSession` | 기획서 §6.2 |
| git (dev) | `git.status, git.log, git.branches, git.diff, git.checkout` | prod에선 Tauri invoke로 동일 계약 |
| fs (dev) | `fs.listDir, fs.readFile, fs.watchProject` | 〃 |
| store (dev) | `store.loadWorkspace, store.saveWorkspace, store.appendMessages, …` | 〃 |
| usage | `usage.weekly(range)` | host 상주 |

git/fs/store RPC의 요청·응답 타입은 **포트 인터페이스와 1:1**이다. 의도적 중복 — 포트가 계약의 원본이고, RPC와 Tauri invoke는 그 계약의 두 운반책일 뿐이다.

## 4. 스키마와 버전 규칙 (C6 방어)

- 모든 메시지는 zod 스키마로 정의하고 **경계에서만** 검증한다 (수신 시 1회. 내부 재검증 금지 — 성능).
- `protocolVersion`은 단일 정수. 호환성 규칙:
  - **추가는 자유** (새 이벤트 type, 새 optional 필드) — 버전 불변.
  - 수신자는 **모르는 event type과 필드를 무시**해야 한다 (zod `passthrough` + discriminated union의 fallback 케이스).
  - 필드 제거·의미 변경 = 버전 증가 = 핸드셰이크에서 거부. **가능한 한 하지 마라** — 새 필드를 추가하고 옛 필드를 한 마일스톤 유지하는 쪽이 항상 싸다.
- golden 테스트: 버전별 샘플 메시지 JSON을 픽스처로 고정, 스키마 변경 시 과거 픽스처가 계속 파싱되는지 CI에서 검증.

## 5. 에러 모델

```ts
type ProtocolError = {
  code: 'adapter_crashed' | 'tool_not_installed' | 'not_logged_in'
      | 'session_not_found' | 'rate_limited' | 'version_mismatch' | 'internal'
  message: string          // 사람이 읽는 설명 (UI 그대로 표시 가능해야 함)
  retryable: boolean
  data?: unknown           // code별 부가 정보 (rate_limited → resumeAt 등)
}
```

- code는 닫힌 집합. UI는 code로 분기하고 message는 표시만 한다. 문자열 매칭 분기 금지.
- 어댑터의 원시 에러(SDK 예외, 프로세스 exit code)는 host 안에서 이 형태로 변환된다.
