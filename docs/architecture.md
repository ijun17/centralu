# 아키텍처

> 목표는 하나다: **예정된 변경이 왔을 때 고치는 곳이 한 군데이게 하라.**

## 1. 변경 축 — 이 설계가 견뎌야 하는 변화

이 프로젝트는 시작 시점부터 큰 변경이 **예정**되어 있다. 아키텍처는 이 목록에 맞춰 설계됐고, 새 결정이 이 축들을 어렵게 만들면 잘못된 결정이다.

| # | 예정된 변경 | 시점 | 격리 장치 |
|---|---|---|---|
| C1 | 실행 환경: **브라우저(웹 개발) → Tauri** | M1 이후 | Platform 포트 (→ [platform-abstraction.md](platform-abstraction.md)) |
| C2 | 서비스 구현 이동: git/store 등 **Node(dev) → Rust(prod)** | Tauri 전환 시, 서비스별 점진 | 포트 인터페이스 고정, 구현만 교체 |
| C3 | 에이전트 도구 추가: Gemini CLI 등 | v2 | AgentAdapter + capability (→ [agent-host.md](agent-host.md)) |
| C4 | Codex 프로토콜 버전 변동 | 수시 | 어댑터 내부 격리 + anti-corruption layer |
| C5 | 화면 구조 변경 (인박스 진화, v2 그리드 등) | 수시 | 순수 도메인 코어 + 파생 상태 셀렉터 |
| C6 | 프로토콜 진화 (이벤트 추가) | 수시 | 스키마 버전 규칙 (→ [protocol.md](protocol.md)) |

## 2. 레이어와 의존 규칙

```
┌────────────────────────────────────────────────────┐
│  apps  (조립: web / desktop 진입점, 여기서만 구현체 선택) │
├────────────────────────────────────────────────────┤
│  ui        React 화면·컴포넌트·훅                     │
├──────────────┬─────────────────────────────────────┤
│  core        │  platform (포트 인터페이스 + 구현체)     │
│  순수 도메인   │   ports/ ← ui가 보는 것               │
│  (IO 없음)    │   web/ tauri/ mock/ ← apps만 아는 것  │
├──────────────┴─────────────────────────────────────┤
│  protocol   메시지·이벤트 스키마 (zod) — 모두의 공용어    │
└────────────────────────────────────────────────────┘
   agent-host (Node 별도 프로세스) ──→ protocol 만 공유
```

**의존 규칙 (위반은 lint 에러다, 리뷰 코멘트가 아니라):**

| 패키지 | 의존 가능 | 절대 금지 |
|---|---|---|
| `ui` | core, platform**/ports**, protocol, React | platform/web, platform/tauri, `@tauri-apps/*`, fetch/WebSocket 직접 사용 |
| `core` | protocol | React, DOM, IO 전부 (순수 TS만) |
| `platform/ports` | protocol | 구현 코드 |
| `platform/web` `platform/tauri` | ports, protocol | ui, core |
| `agent-host` | protocol, 외부 SDK | ui, core, platform |
| `apps/*` | 전부 (조립 담당) | — |

핵심: **구현체를 아는 곳은 apps 진입점 하나뿐이다.** 나머지 전부는 인터페이스와 스키마만 안다.

## 3. 사용하는 디자인 패턴 — 어디에, 왜

패턴은 장식이 아니라 변경 축(C1~C6)에 대한 방어다. 각 패턴이 어느 축을 막는지 명시한다.

| 패턴 | 적용 위치 | 막는 변경 축 |
|---|---|---|
| **포트와 어댑터 (헥사고날)** | `platform/ports`가 UI의 유일한 외부 세계. 구현은 web/tauri | C1, C2 |
| **퍼사드** | `Platform` 객체 하나로 포트 묶음 제공 (`platform.git`, `platform.agents` …) | C1 |
| **의존성 주입** | 부트스트랩에서 Platform 생성 → React Context 하나로 주입. 전역 싱글턴 금지 | C1, 테스트 |
| **어댑터** | `ClaudeAdapter`/`CodexAdapter`가 도구별 차이를 `NormalizedEvent`로 변환 | C3, C4 |
| **Anti-corruption layer** | 외부 SDK 타입은 어댑터 밖으로 **한 발짝도 못 나온다**. protocol 타입으로 즉시 변환 | C4 |
| **명시적 상태 머신** | 세션 상태(FR-12)는 전이 테이블로 정의된 순수 함수. UI에서 if문으로 상태 추론 금지 | C5, 정확성 |
| **이벤트 구동 (pub-sub)** | 어댑터 → 앱 방향은 단방향 이벤트 스트림. 폴링 금지 (기획서 §7.1) | C6, 성능 |
| **CQRS-lite** | 명령(포트 메서드 호출)과 상태 갱신(이벤트 수신→리듀서)의 경로를 분리. 명령의 낙관적 반영 최소화 | C5, C6 |
| **리포지토리** | 영속화는 `StorePort` 뒤에. SQLite 스키마를 아는 건 구현체뿐 | C2 |
| **파생 상태 (셀렉터)** | 인박스·카운터·정렬은 저장하지 않고 세션 상태에서 **계산**한다. 저장하면 동기화 버그의 근원 | C5 |
| **전략** | 카드 접힘 정책, 배너 제자리 승인 판단(도구 종류별) 등 정책성 분기는 데이터(설정 테이블)로 | C5 |

안티패턴 금지 목록: 전역 mutable 싱글턴, UI 컴포넌트에서 직접 IO, 이벤트 핸들러 안의 비즈니스 로직(→ core로), 저장된 파생 상태.

## 4. 프로세스 토폴로지 — dev와 prod의 차이를 최소화한다

**결정: Agent Host와의 통신은 dev/prod 모두 localhost WebSocket이다.**

```
[개발기: 브라우저]                        [프로덕션: Tauri]

Vite dev server                        Tauri 앱 (Rust)
   │                                      │ spawn·감시·재시작 (수퍼바이저)
Browser (ui)                              │ git2/rusqlite/알림/단축키 (Tauri invoke)
   │  WebSocket ws://127.0.0.1:PORT    Webview (ui)
   ▼                                      │  WebSocket ws://127.0.0.1:PORT (동일!)
agent-host (node, 단독 실행)               ▼
   ├─ adapters (claude, codex)         agent-host (node, 사이드카)
   ├─ dev-services (git/fs/store/usage)   ├─ adapters (claude, codex)
   └─ mcp server                          ├─ usage parser · mcp server
                                          └─ (dev-services는 Rust로 대체됨)
```

- **AgentPort 구현이 하나로 유지된다** — dev와 prod가 같은 WS 클라이언트를 쓴다. Tauri의 역할은 통신이 아니라 **프로세스 수퍼바이즈**(spawn, 크래시 감지, 재시작)다. stdio 릴레이(Rust 경유 이중 직렬화)를 만들지 않는다.
- 보안: 임의 포트 + 기동 시 생성한 토큰으로 핸드셰이크, loopback 바인딩만.
- dev 모드에서 git/fs/store는 agent-host 안의 `dev-services` 모듈이 제공한다 (Node로 구현). Tauri 전환 시 이들만 Rust(invoke)로 갈아타고, **포트는 그대로다** (C2). 전환 순서와 방법은 [platform-abstraction.md](platform-abstraction.md) §5.
- 이 구조 덕에 M0~M1을 Rust 툴체인 없이 브라우저 + 핫 리로드로 개발하고, Playwright로 E2E까지 돌릴 수 있다.

## 5. 데이터 흐름 (요약 — 상세는 [state-management.md](state-management.md))

```
사용자 입력 ──→ 포트 메서드 (명령)
                    │
agent-host / tauri ─┴─→ NormalizedEvent 스트림
                            │ (protocol zod 검증)
                    core 리듀서 (순수 함수)
                            │
                    zustand 스토어 (세션·프로젝트 상태)
                            │
                    셀렉터 (인박스, 카운터, 안읽음 — 전부 파생)
                            │
                    React 뷰 (포커스 뷰만 풀 렌더)
```

## 6. 테스트 전략 (레이어별로 다르게)

| 대상 | 방법 | 이유 |
|---|---|---|
| core (상태 머신, 인박스 정렬, 읽음 규칙) | Vitest 단위 테스트, 커버리지 최우선 | 순수 함수라 값싸고, 여기가 제품의 두뇌 |
| protocol | 스키마 golden 테스트 (버전별 샘플 메시지 고정) | C6 회귀 방지 |
| 어댑터 | 계약 테스트: 녹화된 SDK/프로토콜 응답 재생 → NormalizedEvent 검증 | C4. 실 CLI 없이 CI 가능 |
| ui | 핵심 플로우만 Playwright (웹 dev 모드 + mock platform) | 브라우저 개발의 보너스 |
| 의존 규칙 | eslint-plugin-boundaries + dependency-cruiser CI | §2를 문서가 아닌 기계로 강제 |

## 7. M0와의 연결

M0 스파이크(기획서 §8)는 이 구조의 **세로 관통 1회**다: `agent-host`(ClaudeAdapter 1개, WS transport) + `protocol`(이벤트 스키마 최소) + 브라우저에서 접속하는 한 페이지 UI. 여기서 §4의 토폴로지와 권한 오버라이드 전제가 실제로 성립하는지 확인한 뒤 나머지를 채운다.
