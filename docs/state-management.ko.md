# 상태 관리 — 이벤트에서 화면까지

> 영어 원본: [state-management.md](state-management.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

원칙: **상태는 한 방향으로 흐르고, 파생 가능한 것은 저장하지 않는다.**

## 1. 전체 흐름

```
NormalizedEvent (received over WS, zod validation done)
      │
      ▼
core reducer (pure function — the only place state changes)
  applySessionEvent(sessionState, event) → newSessionState
      │
      ▼
zustand store (slices: projects / sessions / messages / usage / settings)
      │                                    │
      ▼                                    ▼
selectors (all derived)                persistence (write-through → StorePort, debounced)
  inbox list and ordering (FR-15)
  global counters "2 approvals · 3 awaiting" (FR-12)
  unread (FR-16)
  concurrent sessions, file conflicts (FR-2)
      │
      ▼
React components (only the focus view subscribes to messages, the rest get summaries)
```

커맨드 방향은 그 역이다: component → store action → port method. 액션은 **낙관적 갱신을 하지 않는다** — 상태 변화는 반드시 이벤트로 되돌아와 reducer를 거쳐야 한다(CQRS-lite). 유일한 예외는 입력창의 로컬 상태다.

## 2. Store 설계 (zustand)

```ts
// A single store, split into slices. Reducers are imported from core — the store only does the wiring
interface AppStore {
  projects: Record<ProjectId, Project>
  sessions: Record<SessionId, SessionMeta>       // summary: state, title, read position etc.
  messages: Record<SessionId, MessageWindow>     // ⚠ only the focused session is fully loaded (§4)
  focus: { sessionId: SessionId | null; tab: Tab }
  // actions
  dispatchEvent(e: NormalizedEvent): void        // → calls the core reducer
  sendMessage(sessionId, input): Promise<void>   // → platform.agents.send
  …
}
```

- **왜 zustand인가**: 이벤트는 React 렌더 사이클 밖(WS 콜백)에서 도착한다. zustand는 React 밖에서의 `store.setState`를 허용하고, 구독 단위를 selector로 잘라 리렌더를 제어할 수 있다. ([tech-stack.ko.md](tech-stack.ko.md) 참고)
- 세션 상태 전이는 반드시 `core/session`의 전이 테이블을 거친다. 불법 전이(예: `state_change`가 주장하는 `idle → waiting_approval`)는 dev 모드에서는 throw하고, prod에서는 로그만 남기고 무시한다. 단 **호스트가 보내 오는 사실(fact)인 `approval_request`/`question_request`는 예외다** — 승인 요청이 실제로 존재하는데 테이블이 막아 버리면 인박스에도 배지에도 영영 나타나지 않고 에이전트는 계속 블록된다(측정됨). 이 둘은 어떤 상태에서든 `waiting_approval`로 전이한다.

## 3. 파생 상태 규칙 (버그의 절반이 여기서 막힌다)

저장 금지 목록 — 다음은 **필드로 존재해서는 안 되며** selector여야 한다:

| 파생 값 | 계산 근거 | 이유 |
|---|---|---|
| 인박스 목록과 순서 | 세션들의 state + 대기 시작 시각 + unread | 저장하면 상태 변화마다 동기화해야 한다 → 유령 항목 버그 |
| 전역 카운터 | 〃 | 〃 |
| 읽음 여부 | `lastMessageSeq > lastReadSeq` | 숫자 두 개의 비교일 뿐이다 |
| 프로젝트 집계 배지 | 소속 세션들의 상태 | 〃 |
| "동시 세션 N개" | 같은 cwd를 가진 활성 세션의 수 | 〃 |

selector는 `core`의 순수 함수를 메모이즈해 감싼 형태로 구현한다. 정렬·긴급도 규칙이 core에 있으므로 단위 테스트는 React 없이 돈다.

## 4. 메시지 윈도잉 (§7.1 메모리 목표를 지키는 방법)

- 세션의 모든 메시지를 메모리에 들고 있지 않는다. **포커스된 세션**: 최근 N개(기본 200) + 위로 스크롤할 때 StorePort에서 페이지 로딩. **포커스되지 않은 세션**: 메시지는 전혀 없고 요약만(마지막 줄, seq, state).
- 포커스를 잃으면 해당 세션의 메시지는 윈도 크기로 잘라 낸다.
- 스트리밍 `message_delta`는 마지막 메시지에 append한다 — 리스트 항목을 다시 만들지 않고(가상 리스트의 measure 재계산 포함) 그 행만 리렌더된다.

## 5. 영속화와 복원 (FR-10)

- **쓰기**: 이벤트 적용 후 write-through. 메시지는 배치로 append하고(500ms debounce), 세션 메타데이터와 워크스페이스는 변경 때마다 쓴다. "종료 시 저장" 같은 개념은 없다 — 크래시 안전성이 공짜로 따라온다.
- **복원 순서**: ① store에서 워크스페이스 + 세션 메타데이터를 로드 → 사이드바와 인박스를 즉시 표시(읽기 전용) → ② 호스트에 연결 → ③ 세션별로 resume 시도 → 성공하면 active로 전환, 실패하면 "기록 보기 + 새 세션" 카드를 표시한다. UI가 호스트 기동을 기다릴 필요가 없다는 점이 콜드 스타트 3초 목표의 핵심이다.
- 이벤트 재연결(`afterSeq`)과 복원의 관계는 [agent-host.ko.md](agent-host.ko.md) §4에 있다.

## 6. 설정이 사는 곳

- 단축키, 알림 정책, 카드 접기 정책, 승인 배너 정책 등은 **데이터**다(전략 패턴의 전략 테이블). `settings` slice + store 영속화로 관리한다.
- 정책 판단 함수는 core에 있고(`shouldCollapseCard(tool, settings)`, `canApproveInBanner(detail, settings)`) UI는 결과만 소비한다. 정책을 바꾸는 것은 데이터 변경이지 컴포넌트 수정이 아니다.
