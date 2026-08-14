# 상태 관리 — 이벤트에서 화면까지

원칙: **상태는 한 방향으로 흐르고, 파생 가능한 것은 저장하지 않는다.**

## 1. 전체 흐름

```
NormalizedEvent (WS 수신, zod 검증 완료)
      │
      ▼
core 리듀서 (순수 함수 — 여기가 유일하게 상태를 바꾸는 곳)
  applySessionEvent(sessionState, event) → newSessionState
      │
      ▼
zustand 스토어 (slice: projects / sessions / messages / usage / settings)
      │                                    │
      ▼                                    ▼
셀렉터 (전부 파생)                      영속화 (write-through → StorePort, debounce)
  인박스 목록·정렬 (FR-15)
  전역 카운터 "승인 2 · 응답대기 3" (FR-12)
  안읽음 (FR-16)
  동시 세션·파일 충돌 (FR-2)
      │
      ▼
React 컴포넌트 (포커스 뷰만 메시지 구독, 나머지는 요약만)
```

명령 방향은 반대로: 컴포넌트 → 스토어 액션 → 포트 메서드. 액션은 **낙관적 갱신을 하지 않는다** — 상태 변화는 반드시 이벤트로 돌아와서 리듀서를 거친다 (CQRS-lite). 예외는 입력창 로컬 상태뿐.

## 2. 스토어 설계 (zustand)

```ts
// 단일 스토어, slice 분할. 리듀서는 core에서 import — 스토어는 배선만
interface AppStore {
  projects: Record<ProjectId, Project>
  sessions: Record<SessionId, SessionMeta>       // 상태·제목·안읽음 위치 등 요약
  messages: Record<SessionId, MessageWindow>     // ⚠ 포커스 세션만 풀 로드 (§4)
  focus: { sessionId: SessionId | null; tab: Tab }
  // actions
  dispatchEvent(e: NormalizedEvent): void        // → core 리듀서 호출
  sendMessage(sessionId, input): Promise<void>   // → platform.agents.send
  …
}
```

- **왜 zustand인가**: 이벤트는 React 렌더 사이클 밖(WS 콜백)에서 도착한다. zustand는 React 외부에서 `store.setState` 가능하고, 구독 단위를 셀렉터로 잘라 리렌더를 통제할 수 있다. (tech-stack.md 참조)
- 세션 상태 전이는 반드시 `core/session`의 전이 테이블을 통과한다. 불법 전이(예: `idle → waiting_approval`)는 dev 모드에서 throw, prod에서 로그 + 무시.

## 3. 파생 상태 규칙 (버그의 절반을 여기서 막는다)

저장 금지 목록 — 다음은 **필드로 존재하면 안 되고** 셀렉터여야 한다:

| 파생 값 | 계산원 | 근거 |
|---|---|---|
| 인박스 목록·순서 | sessions의 state + 대기 시작 시각 + 안읽음 | 저장하면 상태 변화마다 동기화 필요 → 유령 항목 버그 |
| 전역 카운터 | 〃 | 〃 |
| 안읽음 여부 | `lastMessageSeq > lastReadSeq` | 두 수의 비교일 뿐 |
| 프로젝트 집계 뱃지 | 소속 세션들의 상태 | 〃 |
| "동시 세션 N개" | 같은 cwd의 활성 세션 수 | 〃 |

셀렉터는 `core`의 순수 함수를 감싼 메모이즈 래퍼로 구현한다. 정렬·긴급도 규칙이 core에 있으므로 단위 테스트는 React 없이 돈다.

## 4. 메시지 윈도잉 (§7.1 메모리 목표의 실행 방안)

- 세션당 메시지 전체를 메모리에 들고 있지 않는다. **포커스 세션**: 최근 N(기본 200)개 + 위로 스크롤 시 StorePort에서 페이지 로드. **비포커스 세션**: 메시지를 아예 안 들고, 요약(마지막 한 줄·seq·상태)만 유지.
- 포커스 해제 시 해당 세션 메시지는 윈도우 크기로 잘라낸다.
- 스트리밍 `message_delta`는 마지막 메시지에 append — 리스트 항목 재생성 없이 해당 행만 리렌더 (가상 리스트의 measure 재계산 포함).

## 5. 영속화와 복원 (FR-10)

- **쓰기**: 이벤트 적용 후 write-through. 메시지는 배치(500ms debounce) append, 세션 메타·워크스페이스는 변화 시마다. "종료 시 저장"이라는 개념 자체가 없다 — 크래시 대비는 공짜로 얻는다.
- **복원 순서**: ① store에서 워크스페이스+세션 메타 로드 → 사이드바·인박스 즉시 표시(읽기 전용) → ② host 연결 → ③ 세션별 resume 시도 → 성공 시 활성 전환, 실패 시 "기록 보기 + 새 세션" 카드. UI가 뜨는 데 host가 필요 없다는 점이 콜드 스타트 3초 목표의 핵심.
- 이벤트 재연결(`afterSeq`)과 복원의 관계는 [agent-host.md](agent-host.md) §4.

## 6. 설정(settings)의 위치

- 단축키, 알림 정책, 카드 접힘 정책, 승인 배너 정책 등은 **데이터**다 (전략 패턴의 전략 테이블). `settings` slice + store 영속화.
- 정책 판단 함수는 core에 (`shouldCollapseCard(tool, settings)`, `canApproveInBanner(detail, settings)`), UI는 결과만 소비. 정책 변경 = 데이터 변경이지 컴포넌트 수정이 아니다.
