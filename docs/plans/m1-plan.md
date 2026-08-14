# M1 실행 플랜 — "첫날부터 관제 루프가 도는 수준"

- 기준 문서: [product-spec.md](../product-spec.md) §8 M1, [architecture.md](../architecture.md), [m0-findings.md](../spikes/m0-findings.md)
- 진행 방식: 페이즈 순차 진행. 각 태스크는 **완료 기준(검증 방법 포함)** 이 있고, `[루프 가능]` 표시는 기계 판정이 가능해 ralph류 루프에 위임해도 안전한 구간.
- 페이즈 경계마다 사람 확인 게이트. 특히 G5(관제 루프 체감)는 기계 판정 불가 — 직접 써봐야 한다.
- M1 범위 밖 (하지 않는다): Codex 어댑터, 깃 패널 상세, 파일 트리, 코드 뷰어, 첨부, 재시작 복원(M1.5), 사용량 대시보드, 오케스트레이터, Tauri.

## M0 반영 사항 (전 태스크 공통 제약)

1. ClaudeAdapter: `allowedTools` 사용 금지 (canUseTool 셰도잉), `includePartialMessages: true` 사용.
2. 안전 명령 자동 승인은 정상 동작 — 승인 요청 부재를 오류로 취급하지 않는다.
3. Codex 승인 decision 6종은 protocol 설계에 미리 반영 (M2에서 어댑터만 추가되도록).
4. `limit_reached` 이벤트에 `usedPercent?`, `windowMins?` 필드 포함 (Codex가 제공).
5. T3-2에서 SDK 세션의 사용자 훅·플러그인 로드 억제 가능 여부 확인 후 방침 결정 (기본 방향: 억제).

---

## Phase 0 — 모노레포 스캐폴드

**T0-1. pnpm workspace + 패키지 골격** — folder-structure.md 그대로: `packages/{protocol,core,platform,ui,agent-host}`, `apps/web`, `tooling/`, `e2e/`. tsconfig project references, Vitest, Prettier.
완료: `pnpm -r build && pnpm -r test` 통과 (각 패키지 placeholder 1개).

**T0-2. 경계 강제 장치** — eslint flat + eslint-plugin-boundaries + no-restricted-imports/globals (fetch·WebSocket·`@tauri-apps/*` 금지 규칙), dependency-cruiser 설정.
완료: **위반 코드를 일부러 넣은 픽스처가 lint 에러를 내는 것을 테스트로 확인** (규칙이 실제로 작동한다는 증거). `[루프 가능]`

**게이트 G0**: 스캐폴드 커밋. 사람 확인 1분 (구조가 folder-structure.md와 일치하는가).

## Phase 1 — protocol

**T1-1. 봉투 + 이벤트 스키마** — Rpc/RpcRes/Push(seq), NormalizedEvent 전종, ApprovalDetail(3 kind), ProtocolError, SessionState. zod v4, discriminated union + unknown 무시 규칙. protocol.md 기준 + M0 반영 4번.
완료: 타입 추론 = 스키마 일치, golden 픽스처 테스트 통과. `[루프 가능]`

**T1-2. store 스키마 DDL** — `schema.sql` v1: projects/sessions(archived,last_read_seq)/messages/approval_rules/workspace.
완료: better-sqlite3로 마이그레이션 적용 테스트. `[루프 가능]`

## Phase 2 — core (순수 도메인, 여기가 제품의 두뇌)

**T2-1. 세션 상태 머신** — FR-12 전이 테이블 (idle/working/waiting_approval/waiting_input/limited/error), 이벤트→전이 매핑, 불법 전이 처리.
완료: 전이 전수 테스트 (합법 전이 전부 + 불법 전이 대표 케이스). `[루프 가능]`

**T2-2. 인박스 규칙** — 긴급도 정렬(승인→오류→응답대기), 동일 긴급도 내 대기 시작 오름차순, 안읽음 우선 (FR-15/16).
완료: 정렬 property 테스트. `[루프 가능]`

**T2-3. 읽음 규칙** — last_read_seq 비교, 읽음 처리 조건(스크롤 최신 도달 ∥ 포커스 3초) 판정 함수 (FR-16).
완료: 단위 테스트. `[루프 가능]`

**T2-4. 승인 정책** — 배너 제자리 승인 판정(ApprovalDetail.kind 기반), always-allow 규칙 매칭(패턴 + 매치 미리보기용 조회), scope(session/project) (FR-3).
완료: 단위 테스트 (패턴 오적용 케이스 포함). `[루프 가능]`

**T2-5. 리듀서** — applyEvent(state, NormalizedEvent) → 상태 갱신. 파생 셀렉터(인박스·카운터·안읽음·동시세션)용 순수 함수.
완료: 이벤트 시퀀스 재생 테스트 (스파이크 녹화 픽스처 재사용). `[루프 가능]`

**게이트 G2**: core 커버리지 확인. 사람 확인: 상태 머신 전이 테이블이 product-spec FR-12와 일치하는가.

## Phase 3 — agent-host (최소)

**T3-1. transport** — ws 서버, 토큰 핸드셰이크, event-log(seq 부여, 링 버퍼, afterSeq 재전송, resync_required), RPC 라우팅.
완료: 재연결 시나리오 테스트 (연결→이벤트 N개→끊김→afterSeq 재접속→유실분 수신). `[루프 가능]`

**T3-2. ClaudeAdapter** — M0 제약 반영. SDK 이벤트 → NormalizedEvent 변환(델타·tool_use 요약·approval_request(ApprovalDetail 구조화)·turn_complete·usage·rate_limit→limit_reached·session_title), canUseTool↔respondApproval 브리지, interrupt, 사용자 훅 억제 방침 확인·적용.
완료: 계약 테스트 (스파이크 덤프 픽스처 → 이벤트 스냅샷) + **실 세션 스모크 1회** (haiku, 승인 1회 왕복). 스모크는 사람이 실행.

**T3-3. 세션 매니저 + dev-services 최소** — 세션 수명주기(생성·archive·dispose), store(sqlite write-through: 세션 메타·메시지·읽음 위치), git status 요약(브랜치·변경 수만 — 사이드바용), 프로젝트 등록 검증(디렉토리 존재).
완료: RPC 통합 테스트 (인메모리 어댑터 목으로). `[루프 가능]`

**게이트 G3**: 미니 CLI 클라이언트로 실 세션 E2E 스모크 (스파이크 d-host 방식). 사람 확인.

## Phase 4 — platform

**T4-1. ports 정의** — Platform/AgentPort/GitPort/StorePort/SystemPort/capabilities. M1에서 안 쓰는 포트(fs/usage)는 정의만.
완료: 타입 체크 + ui에서 import 가능. `[루프 가능]`

**T4-2. web 구현 + mock 구현** — web: WS RPC 클라이언트(재연결+백오프 ~50줄 자작) + 포트 매핑. mock: 인메모리 전체 구현 + 시나리오 스크립트(세션 N개, 승인 요청 발생기 — Playwright용).
완료: web은 host 대상 통합 테스트, mock은 계약 테스트 공유 (동일 테스트 스위트를 두 구현에 실행). `[루프 가능]`

## Phase 5 — ui + apps/web (관제 루프 완성)

빌드 순서 = 사용 루프 순서. 각 태스크는 mock platform 기반 Playwright 시나리오가 완료 기준의 일부.

**T5-1. 셸** — Vite + Tailwind v4 + PlatformProvider + zustand 배선(dispatchEvent→core 리듀서), 이벤트 구독 시작. 다크/라이트.
완료: mock 이벤트가 스토어에 반영되는 통합 테스트.

**T5-2. 프로젝트 등록 + 사이드바** — 디렉토리 선택(웹 dev에선 경로 입력 폴백), 프로젝트·세션 트리, 상태 점 5종 + 안읽음 점, 브랜치·변경 수 (FR-1).
완료: Playwright — 등록→사이드바 표시→상태 점 갱신.

**T5-3. 포커스 뷰: 대화** — 가상 리스트(@tanstack/react-virtual), 스트리밍 델타 append, 도구 호출 카드(접힘 정책: 조회성 접힘/변경 펼침), 입력창(멀티라인), 중단 버튼 (FR-3 일부).
완료: Playwright — mock 스트리밍 렌더, 60fps는 육안 확인만 (정밀 측정은 M1.5).

**T5-4. 승인 UI** — 승인 카드 y/n/a(+⌥a scope), 전역 배너(제자리 승인/확인 필요 분기 — core 판정 사용), 승인 큐 자동 다음 (FR-3).
완료: Playwright — 승인 3연속 시나리오 (배너 승인 1, 점프 승인 1, 항상 허용 1 → 규칙 저장 확인).

**T5-5. 인박스 + 상태 표시** — ⌘I 인박스(정렬은 core), Enter 점프→처리→자동 다음, `d` 아카이브, 전역 분리 카운터, "다음 대기로 이동" 단축키, 대기 경과 시간 (FR-12/15/17/20 일부).
완료: Playwright — **관제 루프 시나리오**: 대기 5개(승인2+응답3) → 단축키만으로 전부 처리 → "인박스 비움".

**T5-6. 읽음/안읽음 + 자동 이름 + 동시 세션 경고** — 읽음 처리 배선(core 판정), 사이드바 굵기/점, listSessions summary→세션 이름, 수동 변경 시 고정, 생성 다이얼로그 인라인 경고 (FR-16/18/2).
완료: Playwright 각 1 시나리오.

**게이트 G5 (최종·기계 판정 불가)**: **실전 스모크** — 실제 프로젝트 2개 등록, 실 Claude 세션 3개(승인 발생 작업 포함) 동시 구동, 사용자가 §1.3 루프를 직접 돌려본다. 판정 기준: "터미널 3탭보다 나은가". 여기서 나온 불만이 M1.5 백로그가 된다.

## Phase 6 — 마감

**T6-1. E2E 회귀 스위트 정리** — Playwright 시나리오를 e2e/로 통합, CI 스크립트(`pnpm verify` = lint+depcruise+test+e2e). `[루프 가능]`
**T6-2. 유휴 성능 1차 측정** — 세션 4개 idle 상태 CPU 샘플링, 눈에 띄는 위반(폴링·과다 리렌더)만 수정. 정밀 튜닝은 M3.
**T6-3. 스파이크 정리** — `spike/` 삭제 (findings 문서는 유지), README에 개발 실행법 추가.

---

## 실행 메모

- 커밋 단위 = 태스크 단위. 태스크 완료 기준의 테스트가 커밋에 포함되어야 한다 (no fake completion — placeholder·skip 테스트는 미완료로 간주).
- `[루프 가능]` 태스크의 루프 완료 조건은 항상 "`pnpm verify` 통과"로 통일.
- 페이즈 내 태스크는 순서 의존이 명시된 것 외에 병렬 가능 (예: T2-1~T2-4는 상호 독립).
- 실 SDK 호출이 필요한 검증(T3-2 스모크, G3, G5)은 루프에 넣지 않는다 — 비용과 판단이 걸린 구간은 사람이 실행.
