# 아키텍처

> 영어 원본: [architecture.md](architecture.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

> 목표는 하나다: **예상된 변경이 도착했을 때, 고칠 곳이 한 곳이 되게 한다.**

## 1. 변경 축 — 이 설계가 견뎌야 하는 변경들

이 프로젝트에서 큰 변경은 처음부터 **예정되어** 있었다. 아키텍처는 이 목록을 상대로 설계되었고, 이 축들 중 어느 하나라도 더 어렵게 만드는 새 결정은 잘못된 결정이다.

| # | 예상 변경 | 시기 | 격리 장치 |
|---|---|---|---|
| C1 | 실행 환경: **브라우저(웹 개발) → Tauri** | M1 이후 | 플랫폼 포트 (→ [platform-abstraction.ko.md](platform-abstraction.ko.md)) |
| C2 | 서비스 구현 이동: git/store 등 **Node(dev) → Rust(prod)** | Tauri 전환 시점, 서비스별로 점진적으로 | 포트 인터페이스는 고정, 구현만 교체 |
| C3 | 새 에이전트 도구: Gemini CLI 등 | v2 | AgentAdapter + capability (→ [agent-host.ko.md](agent-host.ko.md)) |
| C4 | Codex 프로토콜 버전 변경 | 상시 | 어댑터 내부 격리 + 부패 방지 계층 |
| C5 | 화면 구조 변경 (인박스 진화, v2 그리드 등) | 상시 | 순수 도메인 코어 + 파생 상태 셀렉터 |
| C6 | 프로토콜 진화 (새 이벤트) | 상시 | 스키마 버전 규칙 (→ [protocol.ko.md](protocol.ko.md)) |

## 2. 계층과 의존성 규칙

```
┌────────────────────────────────────────────────────────┐
│  apps  (assembly: web / desktop entry points,          │
│         the only place an implementation is chosen)    │
├────────────────────────────────────────────────────────┤
│  ui        React screens, components, hooks            │
├──────────────┬─────────────────────────────────────────┤
│  core        │  platform (port interfaces + impls)     │
│  pure domain │   ports/ ← what ui sees                 │
│  (no IO)     │   web/ tauri/ mock/ ← only apps know    │
├──────────────┴─────────────────────────────────────────┤
│  protocol   message and event schemas (zod)            │
│             — everyone's shared language               │
└────────────────────────────────────────────────────────┘
   agent-host (separate Node process) ──→ shares protocol only
```

**의존성 규칙 (위반은 리뷰 코멘트가 아니라 lint 에러다):**

| 패키지 | 의존 가능 | 절대 금지 |
|---|---|---|
| `ui` | core, platform**/ports**, protocol, React | platform/web, platform/tauri, `@tauri-apps/*`, fetch/WebSocket 직접 사용 |
| `core` | protocol | React, DOM, 모든 IO (순수 TS만) |
| `platform/ports` | protocol | 구현 코드 |
| `platform/web` `platform/tauri` | ports, protocol | ui, core |
| `agent-host` | protocol, 외부 SDK | ui, core, platform |
| `apps/*` | 전부 (조립을 담당한다) | — |

핵심은 이것이다: **구현을 아는 유일한 곳은 apps 엔트리 포인트다.** 나머지 전부는 인터페이스와 스키마만 안다.

## 3. 사용한 설계 패턴 — 어디에, 왜

패턴은 장식이 아니라 변경 축(C1~C6)에 대한 방어 수단이다. 각 패턴이 어느 축을 막는지 명시한다.

| 패턴 | 적용 위치 | 막는 축 |
|---|---|---|
| **포트와 어댑터 (헥사고날)** | `platform/ports`가 UI에게 유일한 바깥 세계다. 구현은 web/tauri | C1, C2 |
| **퍼사드** | 하나의 `Platform` 객체가 포트 묶음을 제공한다 (`platform.git`, `platform.agents` …) | C1 |
| **의존성 주입** | 부트스트랩에서 Platform을 생성 → 하나의 React Context로 주입. 전역 싱글턴 없음 | C1, 테스트 |
| **어댑터** | `ClaudeAdapter`/`CodexAdapter`가 도구별 차이를 `NormalizedEvent`로 변환한다 | C3, C4 |
| **부패 방지 계층** | 외부 SDK 타입은 어댑터 밖으로 **한 발짝도 나갈 수 없다.** 즉시 protocol 타입으로 변환한다 | C4 |
| **명시적 상태 기계** | 세션 상태(FR-12)는 전이 테이블로 정의된 순수 함수다. UI에서 if 문으로 상태를 추론하는 것은 금지 | C5, 정확성 |
| **이벤트 기반 (pub-sub)** | 어댑터 → 앱 방향은 단방향 이벤트 스트림이다. 폴링 없음 (product spec §7.1) | C6, 성능 |
| **CQRS-lite** | 명령 경로(포트 메서드 호출)와 상태 갱신 경로(이벤트 수신 → 리듀서)를 분리한다. 명령의 낙관적 반영은 최소화 | C5, C6 |
| **리포지토리** | 영속성은 `StorePort` 뒤에 둔다. SQLite 스키마는 구현만 안다 | C2 |
| **파생 상태 (셀렉터)** | 인박스, 카운터, 정렬은 저장하지 않고 세션 상태에서 **계산**한다. 저장하는 것이 동기화 버그의 뿌리다 | C5 |
| **전략** | 정책 분기 — 카드 접기 정책, 인플레이스 배너 승인 판정(도구 종류별) — 는 데이터(설정 테이블)다 | C5 |

금지 안티패턴: 전역 가변 싱글턴, UI 컴포넌트에서의 직접 IO, 이벤트 핸들러 안의 비즈니스 로직(→ core로 옮긴다), 파생 상태 저장.

## 4. 프로세스 토폴로지 — dev와 prod의 차이를 최소화한다

**결정: Agent Host와의 통신은 dev와 prod 모두 localhost WebSocket이다.**

```
[dev machine: browser]                   [production: Tauri]

Vite dev server                        Tauri app (Rust)
   │                                      │ spawn·watch·restart (supervisor)
Browser (ui)                              │ git2/rusqlite/notify/shortcuts (Tauri invoke)
   │  WebSocket ws://127.0.0.1:PORT    Webview (ui)
   ▼                                      │  WebSocket ws://127.0.0.1:PORT (identical!)
agent-host (node, run standalone)         ▼
   ├─ adapters (claude, codex)         agent-host (node, sidecar)
   ├─ dev-services (git/fs/store/usage)   ├─ adapters (claude, codex)
   └─ mcp server                          ├─ usage parser · mcp server
                                          └─ (dev-services replaced by Rust)
```

- **AgentPort 구현은 하나로 유지된다** — dev와 prod가 같은 WS 클라이언트를 쓴다. Tauri의 역할은 통신이 아니라 **프로세스 감독**(spawn, 크래시 감지, 재시작)이다. stdio 릴레이(Rust를 거치는 이중 직렬화)는 만들지 않는다.
- 보안: 임의 포트 + 시작 시 생성한 토큰으로 하는 핸드셰이크, loopback에만 바인딩.
- dev 모드에서는 git/fs/store를 agent-host 안의 `dev-services` 모듈(Node로 구현)이 제공한다. Tauri 전환 시점에 이 부분만 Rust(invoke)로 바뀌고 **포트는 그대로 유지된다**(C2). 전환의 순서와 방법은 [platform-abstraction.ko.md](platform-abstraction.ko.md) §5에 있다.
- 이 구조 덕분에 M0~M1을 Rust 툴체인 없이 브라우저에서 핫 리로드로 개발하고, Playwright로 E2E를 돌릴 수 있다.

## 5. 데이터 흐름 (요약 — 상세는 [state-management.ko.md](state-management.ko.md))

```
user input ──→ port method (command)
                    │
agent-host / tauri ─┴─→ NormalizedEvent stream
                            │ (protocol zod validation)
                    core reducer (pure function)
                            │
                    zustand store (session and project state)
                            │
                    selectors (inbox, counters, unread — all derived)
                            │
                    React views (only the focus view fully renders)
```

## 6. 테스트 전략 (계층마다 다르다)

| 대상 | 방법 | 이유 |
|---|---|---|
| core (상태 기계, 인박스 정렬, 읽음 규칙) | Vitest 단위 테스트, 커버리지 최우선 | 순수 함수라 비용이 싸고, 여기가 제품의 두뇌다 |
| protocol | 스키마 골든 테스트 (버전별 샘플 메시지를 동결) | C6 회귀 방지 |
| adapters | 컨트랙트 테스트: 녹화된 SDK/프로토콜 응답을 재생 → NormalizedEvent 검증 | C4. 실제 CLI 없이 CI에서 가능 |
| ui | 핵심 플로우에만 Playwright (웹 dev 모드 + mock 플랫폼) | 브라우저에서 개발하는 것의 보너스 |
| 의존성 규칙 | CI에서 eslint-plugin-boundaries + dependency-cruiser | §2를 문서가 아니라 기계로 강제 |

## 7. M0과의 연결

M0 스파이크(product spec §8)는 이 구조를 관통하는 **하나의 수직 슬라이스**다: `agent-host`(ClaudeAdapter 1개, WS 전송) + `protocol`(최소 이벤트 스키마) + 브라우저에서 접속하는 단일 페이지 UI. 이것으로 §4의 토폴로지와 권한 오버라이드 전제가 실제로 성립하는지 확인한 뒤, 나머지를 채운다.


## 부록. 3레인 레이아웃 (M2.5 재배치)

탭(대화/파일/git/뷰어)을 걷어내고 3개의 레인으로 교체했다.

```
┌──────┬────────────────────────┬─────────┐
│ obs. │ operate                │ evidence│
│ 240  │ variable               │ 340     │
│ sess.│ conversation           │ changed │
│ list │                        │ filetree│
└──────┴────────────────────────┴─────────┘
              ↑ clicking a file overlays these two
```

### 왜 탭이 아닌가

탭은 **서로 대체 관계인 것들**을 묶는 장치다. 하지만 git 상태는 대화를 대체하는 화면이 아니라, 대화가 주장하는 내용에 대한 **증거**다. 에이전트가 "파일 세 개를 고쳤다"고 말할 때 그것을 확인하는 곳이 여기이므로, 나란히 놓여 있어야 한다. 대체 관계가 아닌 것들을 탭으로 묶은 것이 도그푸딩에서 나온 "git, 파일, 뷰어는 어디서 보나?"를 만들어낸 원인이다.

### 오른쪽 패널 내부: git / files 두 개의 탭

```
┌─ alpha   main        › ─┐   ← press the branch for the switch screen
│ [git] files            │
├────────────────────────┤
│ changed 3        wide  │
│ M src/a.ts             │
│ A src/b.ts             │   ← press for a diff in the overlay
│ ─ push 2               │
│ [commit message ] c  p │
├────────────────────────┤
│ history                │
│ ● fixed inbox ordering │   ← press for the commit in the overlay
│ ○ add session delete ·m│
└────────────────────────┘
```

git 탭은 **서로 다른 두 질문**을 위아래로 배치한다: 위는 "지금 무엇이 바뀌었나", 아래는 "여기까지 어떻게 왔나"다. 커밋과 푸시는 좁은 공간에서도 동작해야 한다 — 확인하고 곧바로 마무리하는 흐름이 끊기면 결국 터미널로 떠나게 된다.

히스토리에는 그래프 선을 그리지 않는다. 340px에서 선을 그리면 제목이 들어갈 자리가 없고, 실제로 알고 싶은 것은 '무엇이 언제 들어왔나'다. 머지만 표시한다.

### 접었을 때: 사라지지 않고 스트립이 남는다

패널을 접으면 32px 세로 스트립이 남는다. `⌘B`를 모른 채 닫아도 돌아갈 길이 눈에 보여야 하고, 스트립은 변경된 파일 수를 유지해서 접힌 상태에서도 "뭔가 바뀌었다"는 것을 읽을 수 있게 한다. 사라진 것과 접힌 것은 다른 것이다.

### 뷰어는 넓은 오버레이다

이 앱에서 뷰어의 주 용도는 사실상 '에이전트가 만든 diff 확인'인데, diff는 340px에서는 읽을 수 없다. 그렇다고 대화의 자리를 차지하면 다 읽은 뒤 되돌아가는 길을 찾아야 한다. 코드를 읽는 것은 깊지만 **짧은** 행위이므로, 덮었다가 esc로 쓸어내는 것이 맞는 메커니즘이다 — 쓸어내면 대화는 스크롤 위치까지 포함해 정확히 그 자리에 그대로 있다.

오버레이는 **가운데와 오른쪽만** 덮는다. 왼쪽까지 덮으면 코드를 읽는 동안 다른 세션이 나를 부르는 것을 놓친다. 그것은 관제탑에서 계기판을 가리는 일이다.

### 단축키 변경

| 이전 | 이후 |
|---|---|
| `⌘⇧1~4` 탭 전환 | `⌘B` evidence 패널 접기/펴기 |
| (없음) | `esc` 오버레이 쓸어내기 |

`⌘1~9` 프로젝트 이동, `⌘I` 인박스, `⌘K` 팔레트, `⌘⇧A` 다음 대기 항목은 그대로다.
