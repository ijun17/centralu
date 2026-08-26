# 폴더 구조와 패키지 분할

> 영어 원본: [folder-structure.md](folder-structure.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

pnpm workspaces 모노레포다. 패키지 경계 = 의존성 규칙 경계 = lint가 강제하는 단위.

## 1. 전체 구조

```
centralu/
├─ README.md                    # introduction (for users). The Korean edition is README.ko.md
├─ CONTRIBUTING.md              # how to run development, verification, CLA
├─ docs/                        # the spec (product-spec.md) + design documents (this folder)
│  └─ README.md                 # documentation map
├─ package.json                 # workspace root (script hub)
├─ pnpm-workspace.yaml
│
├─ apps/
│  ├─ web/                      # web entry point for development (Vite)
│  │  ├─ index.html
│  │  └─ src/main.tsx           # injects createWebPlatform() — the only place ① that knows an implementation
│  └─ desktop/                  # Tauri entry point (created after M1)
│     ├─ src/main.tsx           # injects createTauriPlatform() — the only place ②
│     └─ src-tauri/             # Rust: supervisor, git2, rusqlite, OS integration
│        ├─ Cargo.toml
│        └─ src/
│
├─ packages/
│  ├─ protocol/                 # the shared language: event and command schemas (zod). 0 dependencies
│  │  └─ src/
│  │     ├─ events.ts           # the NormalizedEvent family
│  │     ├─ commands.ts         # request/response RPC
│  │     ├─ entities.ts         # shared types such as SessionState, Capability
│  │     └─ version.ts
│  │
│  ├─ core/                     # pure domain. No IO, no React
│  │  └─ src/
│  │     ├─ session/            # state machine (transition table), session reducer
│  │     ├─ inbox/              # ordering and urgency rules (all pure functions)
│  │     ├─ unread/             # read rules (FR-16)
│  │     ├─ approval/           # always-allow rule matching, in-place approval policy
│  │     └─ usage/              # weekly aggregation (the calculation, not the parser)
│  │
│  ├─ platform/                 # the firewall for C1/C2
│  │  └─ src/
│  │     ├─ ports/              # interfaces only. The only subpath ui may import
│  │     │  ├─ agent.ts  git.ts  fs.ts  store.ts  usage.ts  system.ts
│  │     │  └─ platform.ts      # the Platform facade + PlatformCapabilities
│  │     ├─ web/                # browser implementation (WS/HTTP → agent-host)
│  │     ├─ tauri/              # Tauri implementation (invoke/event) — after M1
│  │     └─ mock/               # in-memory implementation for tests and stories
│  │
│  ├─ ui/                       # the whole React app (except the entry point)
│  │  └─ src/
│  │     ├─ app/                # root component, routing (view switching), PlatformProvider
│  │     ├─ features/           # vertical split by feature (§2 below)
│  │     │  ├─ inbox/  session/  approval/  sidebar/
│  │     │  ├─ git/  file-tree/  code-viewer/
│  │     │  └─ usage/  settings/  onboarding/
│  │     ├─ components/         # feature-agnostic shared (Button, Kbd, VirtualList…)
│  │     ├─ store/              # zustand store + selectors (reducers are imported from core)
│  │     └─ styles/
│  │
│  └─ agent-host/               # the Node process (no browser code)
│     └─ src/
│        ├─ main.ts             # CLI entry (--port, --token)
│        ├─ transport/          # WS server, session handshake
│        ├─ adapters/           # claude/, codex/ + the common adapter contract
│        ├─ dev-services/       # dev-only: git, fs, store (sqlite), watcher
│        ├─ usage/              # incremental parser for ~/.claude, ~/.codex logs
│        └─ mcp/                # MCP server for the orchestrator (M3)
│
├─ e2e/                         # Playwright (apps/web + platform/mock combination)
└─ tooling/                     # eslint config, dependency-cruiser rules, shared tsconfig
```

## 2. ui/features 내부 규칙 (수직 분할)

각 feature 폴더는 자기완결적이다:

```
features/inbox/
├─ InboxView.tsx        # the screen
├─ components/          # sub-components for this feature only
├─ hooks.ts             # hooks for this feature only (combinations of store selectors)
└─ index.ts             # the public surface (barrel) — other features import only through here
```

- feature 간 직접 import는 `index.ts`를 통해서만 한다. 깊은 경로 import는 금지한다(lint로 강제).
- 두 feature가 같은 로직을 원하면 그 로직은 core나 components로 **내려보낸다**. feature 간 수평 의존을 늘리지 않는다.
- 화면에 붙는 상태는 store에 둔다. 컴포넌트 로컬 상태(입력 중인 텍스트 등)만 useState를 쓴다.

## 3. 확장 시나리오별 "코드가 갈 곳"

| 하려는 것 | 손대는 곳 | 손대면 안 되는 곳 |
|---|---|---|
| 에이전트 툴 추가 (Gemini 등) | `agent-host/adapters/gemini/` + capability 선언 | ui, core (이벤트가 정규화되어 있으므로) |
| 새로운 종류의 이벤트 추가 | `protocol/events.ts` → core reducer → 소비하는 feature | 다른 feature들 |
| git을 Node에서 Rust로 이동 (C2) | 새 `platform/tauri/git.ts` + `src-tauri` | ports/git.ts (인터페이스는 그대로다), ui |
| 새 화면 추가 | `ui/features/<new>/` | platform, agent-host |
| OS 알림 동작 방식 변경 | `platform/{web,tauri}/system.ts` | ui (SystemPort 뒤에 있으므로) |
| 세션 상태 규칙 변경 | `core/session/` (+ 전이 테이블 테스트) | ui의 if 문 — 애초에 존재해서는 안 된다 |

## 4. 왜 모노레포인가 (그리고 왜 이 크기인가)

- ui와 agent-host는 protocol을 **같은 타입으로** 공유해야 한다 — 저장소를 나누는 순간 버전 표류가 시작된다.
- 패키지 5개는 1인 개발에 과하지 않다: 각 경계가 tsconfig `references`로 빌드 격리를 얻고 lint 규칙의 단위가 된다. 같은 것을 하나의 src/ 아래 폴더로만 나누면 경계가 관례에 그치고, 관례는 마감 앞에서 무너진다.
- Turborepo 같은 빌드 오케스트레이터는 **지금은 추가하지 않는다** — 이 규모에서는 pnpm 스크립트로 충분하다. 빌드가 느려지면 그때 추가한다(YAGNI).
