# 폴더 구조와 패키지 분할

pnpm workspaces 모노레포. 패키지 경계 = 의존 규칙 경계 = lint 강제 단위.

## 1. 전체 구조

```
centralu/
├─ README.md                    # 소개 (사용자용). 한국어판은 README.ko.md
├─ CONTRIBUTING.md              # 개발 실행법·검증·CLA
├─ docs/                        # 기획서(product-spec.md) + 설계 문서 (이 폴더)
│  └─ README.md                 # 문서 지도
├─ package.json                 # workspace 루트 (스크립트 허브)
├─ pnpm-workspace.yaml
│
├─ apps/
│  ├─ web/                      # 개발용 웹 진입점 (Vite)
│  │  ├─ index.html
│  │  └─ src/main.tsx           # createWebPlatform() 주입 — 구현체를 아는 유일한 곳 ①
│  └─ desktop/                  # Tauri 진입점 (M1 이후 생성)
│     ├─ src/main.tsx           # createTauriPlatform() 주입 — 유일한 곳 ②
│     └─ src-tauri/             # Rust: 수퍼바이저, git2, rusqlite, OS 통합
│        ├─ Cargo.toml
│        └─ src/
│
├─ packages/
│  ├─ protocol/                 # 공용어: 이벤트·명령 스키마 (zod). 의존 0
│  │  └─ src/
│  │     ├─ events.ts           # NormalizedEvent 계열
│  │     ├─ commands.ts         # 요청/응답 RPC
│  │     ├─ entities.ts         # SessionState, Capability 등 공유 타입
│  │     └─ version.ts
│  │
│  ├─ core/                     # 순수 도메인. IO·React 금지
│  │  └─ src/
│  │     ├─ session/            # 상태 머신 (전이 테이블), 세션 리듀서
│  │     ├─ inbox/              # 정렬·긴급도 규칙 (전부 순수 함수)
│  │     ├─ unread/             # 읽음 규칙 (FR-16)
│  │     ├─ approval/           # 항상 허용 규칙 매칭, 제자리 승인 판단 정책
│  │     └─ usage/              # 주간 집계 계산 (파서 말고 계산만)
│  │
│  ├─ platform/                 # C1/C2의 방화벽
│  │  └─ src/
│  │     ├─ ports/              # 인터페이스만. ui가 import 가능한 유일한 하위 경로
│  │     │  ├─ agent.ts  git.ts  fs.ts  store.ts  usage.ts  system.ts
│  │     │  └─ platform.ts      # Platform 퍼사드 + PlatformCapabilities
│  │     ├─ web/                # 브라우저 구현 (WS/HTTP → agent-host)
│  │     ├─ tauri/              # Tauri 구현 (invoke/event) — M1 이후
│  │     └─ mock/               # 테스트·스토리용 인메모리 구현
│  │
│  ├─ ui/                       # React 앱 전체 (진입점 제외)
│  │  └─ src/
│  │     ├─ app/                # 루트 컴포넌트, 라우팅(뷰 전환), PlatformProvider
│  │     ├─ features/           # 기능 단위 수직 분할 (아래 §2)
│  │     │  ├─ inbox/  session/  approval/  sidebar/
│  │     │  ├─ git/  file-tree/  code-viewer/
│  │     │  └─ usage/  settings/  onboarding/
│  │     ├─ components/         # 기능 무관 공용 (Button, Kbd, VirtualList…)
│  │     ├─ store/              # zustand 스토어 + 셀렉터 (리듀서는 core에서 import)
│  │     └─ styles/
│  │
│  └─ agent-host/               # Node 프로세스 (브라우저 코드 금지)
│     └─ src/
│        ├─ main.ts             # CLI 진입 (--port, --token)
│        ├─ transport/          # WS 서버, 세션 핸드셰이크
│        ├─ adapters/           # claude/, codex/ + 공통 어댑터 계약
│        ├─ dev-services/       # dev 전용: git, fs, store(sqlite), watcher
│        ├─ usage/              # ~/.claude, ~/.codex 로그 증분 파서
│        └─ mcp/                # 오케스트레이터용 MCP 서버 (M3)
│
├─ e2e/                         # Playwright (apps/web + platform/mock 조합)
└─ tooling/                     # eslint 설정, dependency-cruiser 규칙, 공용 tsconfig
```

## 2. ui/features 내부 규칙 (수직 분할)

각 feature 폴더는 자기 완결적이다:

```
features/inbox/
├─ InboxView.tsx        # 화면
├─ components/          # 이 기능 전용 하위 컴포넌트
├─ hooks.ts             # 이 기능 전용 훅 (스토어 셀렉터 조합)
└─ index.ts             # 외부 공개 표면 (barrel) — 다른 feature는 여기로만 import
```

- feature 간 직접 import는 `index.ts` 경유만. 깊은 경로 import 금지 (lint로 강제).
- 두 feature가 같은 로직을 원하면 그 로직은 core나 components로 **내려간다**. feature 간 수평 의존을 늘리지 않는다.
- 화면에 붙는 상태는 스토어에, 컴포넌트 로컬 상태(입력 중 텍스트 등)만 useState.

## 3. 확장 시나리오별 "코드가 갈 곳"

| 하려는 일 | 만지는 곳 | 만지면 안 되는 곳 |
|---|---|---|
| 에이전트 도구 추가 (Gemini 등) | `agent-host/adapters/gemini/` + capability 선언 | ui, core (이벤트가 정규화돼 있으므로) |
| 새 이벤트 종류 추가 | `protocol/events.ts` → core 리듀서 → 소비하는 feature | 다른 feature |
| git을 Node→Rust로 이동 (C2) | `platform/tauri/git.ts` 신규 + `src-tauri` | ports/git.ts (인터페이스 불변), ui |
| 새 화면 추가 | `ui/features/<новое>/` | platform, agent-host |
| OS 알림 방식 변경 | `platform/{web,tauri}/system.ts` | ui (SystemPort 뒤라서) |
| 세션 상태 규칙 변경 | `core/session/` (+ 전이 테이블 테스트) | ui의 if문 — 애초에 없어야 함 |

## 4. 왜 모노레포인가 (그리고 왜 이 정도 크기인가)

- protocol을 ui와 agent-host가 **같은 타입으로** 공유해야 한다 — 별도 레포면 버전 드리프트가 바로 생긴다.
- 패키지 5개는 솔로 개발에 과하지 않다: 경계마다 tsconfig `references`로 빌드 격리, lint 규칙의 단위가 된다. 반대로 이걸 한 src/에 폴더로만 나누면 경계가 관습이 되고, 관습은 마감 앞에서 무너진다.
- Turborepo 같은 빌드 오케스트레이터는 **지금 넣지 않는다** — pnpm 스크립트로 충분한 규모. 빌드가 느려지면 그때 추가 (YAGNI).
