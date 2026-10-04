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

- **AgentPort 구현은 하나로 유지된다** — dev와 prod가 같은 WS 클라이언트를 쓴다. Tauri의 역할은 통신이 아니라 **프로세스 감독**(spawn, 크래시 감지, 재시작)이다 — 패키지된 앱에서는 키퍼를 통해서(§4.1). stdio 릴레이(Rust를 거치는 이중 직렬화)는 만들지 않는다.
- 보안: 임의 포트 + 시작 시 생성한 토큰으로 하는 핸드셰이크, loopback에만 바인딩. 브라우저/WebView 클라이언트는 명시된 dev/Tauri origin allowlist에도 들어야 한다. `Origin` 헤더가 없는 네이티브 클라이언트도 토큰은 필요하고, literal `Origin: null`은 거부한다.
- dev 모드에서는 git/fs/store를 agent-host 안의 `dev-services` 모듈(Node로 구현)이 제공한다. Tauri 전환 시점에 이 부분만 Rust(invoke)로 바뀌고 **포트는 그대로 유지된다**(C2). 전환의 순서와 방법은 [platform-abstraction.ko.md](platform-abstraction.ko.md) §5에 있다.
- 이 구조 덕분에 M0~M1을 Rust 툴체인 없이 브라우저에서 핫 리로드로 개발하고, Playwright로 E2E를 돌릴 수 있다.

### 4.1 키퍼: 호스트가 창보다 오래 산다 (#280, 옵션 C 1단계)

패키지된 앱에서는 Tauri 앱이 더 이상 호스트의 부모가 아니다. 호스트는 **키퍼**가 쥔다: 같은 Centralu 실행 파일을
`centralu --keeper`로 띄운 것으로, 앱에서 떨어져 자기 세션에서 돈다.

```
Tauri app (window)  ──attach──▶  keeper (centralu --keeper, own session)
   │                 unix socket     │ launch · watch · restart · swap
   │                 <data>/keeper.sock, 0600
   │                                 │
   └── WebSocket ──▶ front door ─────┴─ bytes ─▶ agent-host (node, from <data>/hosts/<build>/)
       ws://127.0.0.1:DOOR   (one port and token per keeper)
```

| 결정 | 이유 |
|---|---|
| 키퍼는 두 번째 바이너리가 아니라 앱 실행 파일의 한 모드다 | 서명하고 내보낼 것이 하나이고, 서명과 번들 식별자가 같으므로 macOS가 개인정보 권한을 새 프로그램이 아니라 Centralu에 돌릴 것이다(#220). `main()`이 Tauri 앱을 만들기 전에 갈라지므로 키퍼 모드는 창을 열지도 웹뷰를 띄우지도 않는다. |
| 앱이 떼어서 띄운다 (`setsid`, stdin `/dev/null`) | 앱이 끝나든 죽든 바뀌든 키퍼에게는 아무것도 가지 않는다. launchd와 `SMAppService`는 나중 선택지이고 1단계가 아니다. |
| 호스트는 키퍼에 묶인다 (키퍼의 파이프에 `--watch-parent`) | 키퍼가 어떻게 죽든 호스트를 데려간다: 주인 없는 호스트는 생기지 않는다. |
| 모든 호스트는 빌드별 사본 `<data>/hosts/<commit>/`에서 돈다 | 다시 빌드하거나 업데이트하면 번들이 바뀐다. 번들에서 돌던 호스트는 Codex 브리지·`schema.sql`·`app-template/`을 필요할 때 읽어 두 빌드를 섞을 수 있었다(2026-10-03). 아무 호스트도 쓰지 않는 사본은 호스트가 뜨면 지운다. |
| 백그라운드 모드는 설정이고 기본은 꺼짐 | 꺼짐: 마지막 창이 떨어지면 키퍼와 호스트가 멈춘다, 앱을 끄던 그대로. 켜짐: 계속 돌고, 다시 연 앱이 다시 붙는다. "Quit and stop agents"는 어느 쪽이든 멈춘다. |
| 백그라운드 모드에서 지켜보는 이 없는 키퍼는 창도 활동도 없이 30분이 지나면 끝난다 | 아무도 보지 않는 호스트를 끝낼 무언가가 있어야 한다. 활동(일하거나 기다리는 세션, 터미널, 명령 실행)은 호스트가 stdout에 내는 자기 보고이고, 키퍼는 그 밖에 아무것도 해석하지 않는다. 도는 턴이나 기다리는 승인은 얼마가 걸리든 키퍼를 살려 둔다. |
| 다른 빌드의 창은 도는 호스트에 붙고 바꾸기를 권한다 | 키퍼는 두 빌드를 다 안다. 바꾸기는 §4.2의 블루그린 교체이고, 잃을 것이 있을 때만 창이 먼저 묻는다. |
| 디버그 빌드(`pnpm app:dev`)는 직접 경로를 유지한다 | 거기서는 앱이 호스트의 부모다, 예전 그대로. `CC_USE_KEEPER=1`이면 디버그 빌드도 키퍼를 쓴다. unix가 아닌 대상에는 아직 키퍼가 없다. |

키퍼가 아직 하지 않는 일: 에이전트·터미널·프로젝트 명령을 쥐는 일(2단계). 그때까지는 호스트를 다시 띄우거나 바꾸면
여전히 호스트의 자식이 모두 끝난다. 제어 소켓과 그 프로토콜, 신뢰 규칙은
[agent-host.ko.md](agent-host.ko.md) §4.1과 [security-boundaries.md](security-boundaries.md)에 있다.

### 4.2 정문과 블루그린 교체 (#280, 옵션 C 3단계)

클라이언트는 호스트 자신의 포트를 알지 못한다. 키퍼는 살아 있는 동안 루프백 포트 하나, **정문**(front door)에서
듣고, 들어온 연결을 그때의 호스트로 바이트 그대로 넘긴다. 웹뷰, 브라우저, 모든 Codex 오케스트레이터 브리지가
여기로 붙는다.

| 결정 | 이유 |
|---|---|
| WebSocket 프록시가 아니라 바이트 중계 | 키퍼는 어떤 프로토콜도 해석하지 않는다(#280). 바이트 중계는 호스트 프레임이 바뀌어도 깨지지 않고, 앱 뷰의 HTTP 문도 그대로 지나간다. |
| 토큰은 키퍼가 쥐고 모든 호스트에 넘긴다 (`CC_HOST_TOKEN`) | `hello`와 브라우저의 `Origin`은 여전히 호스트가 직접 검사한다. 토큰과 포트는 재시작과 교체를 거쳐도 같아서, 클라이언트에게 다시 알려 줄 일이 없다. 이것이 없애는 측정된 위험: Codex 브리지는 스레드가 시작될 때 주소와 토큰을 한 번 받고, 도는 codex는 그 브리지를 계속 쥐므로, 새 포트나 새 토큰의 호스트는 모든 브리지를 조용히 끊었다. |
| 준비된 호스트가 없는 동안 새 연결은 거절하지 않고 붙잡는다 (최대 45초) | 곧바로 다시 붙는 클라이언트는 실패하고 물러서는 대신, 다음 호스트가 뜨자마자 그리로 간다. 측정: 교체로 끊긴 클라이언트를 새 호스트가 84–86 ms 뒤에 맞았다. |
| Codex 브리지에는 정문 주소를 준다 | 브리지는 환경을 한 번만 읽는다. 호스트보다 오래 사는 주소만 교체를 견딘다. 브리지는 닫힌 소켓에서 기다리던 호출을 바로 실패시키고 다음 호출에서 다시 붙는다. |

`switch`는 **블루그린 교체**다 (`keeper/swap.rs`):

1. 키퍼가 새 빌드의 빌드별 사본에서 호스트 B를 `--standby`로 띄운다. B는 번들을 읽고, 도구를 찾고, 저장소를 쓰지
   않고 읽고, 자기가 읽을 수 없는 저장소면 거절하고, 보고한 뒤 기다린다. 잠금을 잡지 않고, 마이그레이션을 돌리지
   않고, 아무것에도 붙지 않는다. 호스트 A는 계속 일한다.
2. 60초 안에 보고가 없거나 B가 끝나면: B를 멈추고 사본을 지운다. A는 건드린 적이 없다.
3. 정문이 새 연결을 붙잡고, A에게 **드레인**하라고 한다: 새 RPC와 도구 호출을 거절하고, 도는 것에는 최대 10초를
   주고, 남은 것은 모델이 다시 시도할 수 있는 오류로 끊고, 떼어 내고(detach), 저장소를 비우고 닫고, #278 잠금을
   놓고 끝난다.
4. B에게 활성화하라고 한다: 잠금을 잡고, 확장(expand) 마이그레이션만 돌리고(무거운 단계와 깨는 단계는 준비된 뒤에
   돈다, [agent-host.ko.md](agent-host.ko.md) §5.1), 시작하고, 듣고, 준비됐다고 알린다.
5. 정문이 B를 가리키고, 아직 A로 중계되던 연결을 닫는다. 클라이언트는 같은 주소로 다시 붙고 B의 새 stream
   epoch로 다시 맞춘다. A의 사본은 지운다.

| 결정 | 이유 |
|---|---|
| 드레인 한도 10초, 그 뒤에는 다시 시도할 수 있는 오류로 끊는다 | 드레인이 필요한 것은 호스트가 직접 처리하는 호출뿐이다: 실제 저장소에서 오케스트레이터 도구는 최대 0.2초, 앱 도구는 최대 5.6초가 걸렸다. Bash와 서브에이전트는 호스트보다 오래 사는 에이전트 프로세스 안에서 돈다. 모든 도구를 기다리는 것은 처음부터 선택지가 아니었다(p99 78초, 최대 4.5시간). |
| B는 A가 드레인하기 전에 자기를 점검하고, 마이그레이션은 그 뒤에만 한다 | 점검이 실패해도 잃는 것이 없다: A는 그대로다. 교체 중에는 확장 단계만 돌리므로 저장소는 A의 빌드가 여전히 읽을 수 있다. |
| A가 드레인한 뒤 B가 실패하면 A의 빌드를 다시 띄운다 | A는 이미 끝났고 잠금을 놓았으니 이어 갈 수 없다. A의 빌드는 잘 돈다고 알려져 있고 저장소도 여전히 읽으며, 그 사본은 교체가 성공할 때까지 남는다. B를 다시 시도하는 쪽도 있었지만, 방금 시작에 실패한 빌드가 지금 뜰 가능성이 더 낮다. 창은 실패와 이전 빌드가 다시 일한다는 것을 보여 주고, 사람은 다시 시도할 수 있다. |
| 모든 단계를 붙은 창에 밀어 준다 (`view.swap`) | 창은 진행과 실패 이유를 보여 주고, 잃을 것이 있을 때만(일하거나 기다리는 세션, 터미널, 명령) 바꾸기 전에 묻는다. |
| 2단계 전까지 교체의 detach는 종료와 같은 일을 한다 | 키퍼가 쥐기 전까지 에이전트·터미널·명령은 호스트의 자식이므로, 교체는 여전히 도는 턴을 끝낸다. 호스트는 `keepsAgents: false`를 알리고 창도 그렇게 말한다. 2단계가 detach 훅을 채우고 이 보고를 바꾼다. |


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
