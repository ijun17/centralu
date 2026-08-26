# 플랫폼 추상화 — 웹에서 개발하고 Tauri로 배포한다

> 영어 원본: [platform-abstraction.md](platform-abstraction.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

> 규칙 하나: **ui 코드는 fetch도, WebSocket도, `@tauri-apps/*`도 모른다. 포트만 안다.**

이 문서는 변경 축 C1(브라우저 → Tauri)과 C2(구현이 Node → Rust로 이동)에 대한 완전한 답이다.

## 1. 왜 이렇게 하는가

- M0~M1은 브라우저에서 개발한다: hot reload, DevTools, Playwright, Rust 툴체인 불필요.
- 목표는 그 코드를 **한 줄도 바꾸지 않고** Tauri webview에 넣는 것이다. 그러려면 "바깥 세계"와의 모든 접점이 인터페이스 뒤에 있어야 한다.
- 접점을 흩어 놓으면(컴포넌트마다 fetch) 이전 비용 = 전체 grep. 모아 놓으면 이전 비용 = 구현 패키지 하나.

## 2. Platform 파사드와 포트

```ts
// platform/ports/platform.ts
export interface Platform {
  agents: AgentPort      // create/send/approve/interrupt sessions + subscribe to events
  git: GitPort           // status/log/branches/diff/checkout
  fs: FsPort             // lazy tree listing, read file, watch
  store: StorePort       // persist workspace, sessions, messages, rules
  usage: UsagePort       // query weekly aggregation (calculation in core, raw parsing in the host)
  system: SystemPort     // notifications, badge, global shortcuts, open in IDE, file dialogs
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}

export interface PlatformCapabilities {
  osNotifications: boolean      // web: Notification API, limited / tauri: true
  dockBadge: boolean            // web: false / tauri: true
  globalShortcuts: boolean      // web: only within window focus / tauri: true
  processSupervision: boolean   // web: false (the user starts the host) / tauri: true
  openInIde: boolean            // web: false / tauri: true
  // Not every capability is a yes/no. These two are facts about the machine that the UI
  // needs in order to draw, asked for as a measurement and as labels rather than as an OS
  // name — so that ui still never learns which OS it is on.
  windowControlsInset: number   // px the OS window controls take from our top bar (macOS: 86)
  shortcutKeys: ShortcutKeys    // { mod, alt, join } — '⌘'/'⌥'/'' here, 'Ctrl'/'Alt'/'+' elsewhere
}
```

포트 시그니처 규칙:

- 모든 메서드는 `Promise`를 반환한다 (동기 구현이라도) — 구현이 IPC가 되어도 시그니처가 바뀌지 않는다.
- 스트림은 `subscribe(handler): Unsubscribe`로 표준화한다. AsyncIterator는 쓰지 않는다 (React 통합과 teardown 관리가 번거롭다).
- 포트의 입출력 타입은 전부 `protocol`에서 온다. 구현 세부(Tauri의 이벤트 이름, WS 프레임)는 절대 노출되면 안 된다.
- 에러는 `PlatformError { code, message, retryable }`로 정규화한다. 구현별 예외를 그대로 던지지 않는다.

## 3. 구현 매트릭스

| 포트 | `platform/web` (dev) | `platform/tauri` (prod) | 비고 |
|---|---|---|---|
| agents | **WS → agent-host** | **같은 WS 클라이언트를 재사용** | 유일하게 구현이 하나인 포트 (architecture §4 결정) |
| git | WS → host `dev-services/git` | Tauri invoke → Rust git2 | C2 대상 |
| fs | WS → host `dev-services/fs` | Tauri invoke → Rust | C2 대상 |
| store | WS → host `dev-services/store` (better-sqlite3) | Tauri invoke → rusqlite | C2 대상. **스키마는 공유** (DDL 버전은 protocol에 명시) |
| usage | WS → host `usage` | WS → host `usage` (파서는 호스트에 남는다) | 로그 파싱은 Node에 남긴다 — Rust로 다시 쓸 이득이 없다 |
| system | 웹 폴백 (Notification API, no-op badge) | Tauri 플러그인 | UI는 capabilities를 통해 우아하게 축소된다 |

요점: **웹 구현의 대부분은 "WS로 호스트에 위임"이다.** 그래서 웹 구현은 사실상 RPC 클라이언트 하나 + 포트별 얇은 매핑이고, 실제 일은 호스트의 dev-services가 한다. Tauri 이전 시에는 dev-services만 Rust로 옮기면 된다.

## 4. 부트스트랩 — 구현을 아는 유일한 곳

```ts
// apps/web/src/main.tsx
const platform = await createWebPlatform({
  hostUrl: import.meta.env.VITE_HOST_URL ?? 'ws://127.0.0.1:5175',
  token: import.meta.env.VITE_HOST_TOKEN,
})
createRoot(el).render(<App platform={platform} />)

// apps/desktop/src/main.tsx  (after M1)
const platform = await createTauriPlatform()   // internally invokes for sidecar info, then connects over WS
createRoot(el).render(<App platform={platform} />)
```

```tsx
// ui/app/PlatformProvider.tsx — the only channel through which ui receives a Platform
const PlatformContext = createContext<Platform | null>(null)
export const usePlatform = () => { /* null-check then return */ }
export const useCapability = (k: keyof PlatformCapabilities) => usePlatform().capabilities[k]
```

- 환경 감지(`window.__TAURI__` 존재 여부)로 자동 분기하지 **않는다** — 진입점이 다르므로 감지는 불필요하고, 감지 로직은 숨은 의존성이 된다.
- 컴포넌트가 `usePlatform()`을 직접 쓰는 일조차 드물어야 한다. 스토어 액션(스토어가 포트를 호출)과 셀렉터로 대부분 충분하다.

## 5. 이전 플레이북 (C1, C2의 실행 순서)

Tauri 이전은 빅뱅이 아니라 **서비스별 점진 이전**이다:

1. `apps/desktop`을 만들고 Tauri가 agent-host를 사이드카로 spawn하게 한다 (수퍼바이저만 구현).
2. `createTauriPlatform()`의 첫 버전 = **웹 구현을 그대로 재사용** (전부 WS로 위임). 이 시점에 데스크톱 앱이 이미 돈다 — UI 변경 0줄.
3. system 포트를 Tauri 플러그인으로 교체한다 (알림, 배지, 단축키, IDE에서 열기). capabilities가 true로 바뀌고 UI 기능들이 스스로 켜진다.

4~6단계(git, store, fs의 Rust 이전)는 **보류** 상태다 (2026-08-15).

M1.5에서 Tauri가 Node 사이드카를 그대로 감독하는 구조로 정착했고, WS 경로를 dev와 prod가
공유하게 되면서 이전의 실익이 사라졌다. M2 측정에서도 병목은 없었다 (유휴 CPU 0%).
**성능 문제가 실제로 측정될 때만** 재개한다 — 포트 인터페이스가 같으므로 그때 옮겨도 UI는 변경되지 않는다.
현재 시점의 사실: `agent-host/dev-services`가 dev와 prod 양쪽의 구현이다.

각 단계는 독립적으로 배포 가능하고, 문제가 생기면 그 단계만 롤백한다.

## 6. 강제 — 규칙은 기계가 지킨다

```jsonc
// eslint: applied to the ui package
"no-restricted-imports": ["error", { "patterns": [
  { "group": ["@tauri-apps/*"], "message": "only in platform/tauri" },
  { "group": ["@cc/platform/web", "@cc/platform/tauri"],
    "message": "ui gets ports only. Implementations are injected at the apps entry point" }
]}],
"no-restricted-globals": ["error",
  { "name": "fetch", "message": "no direct network calls in ui — go through a port" },
  { "name": "WebSocket", "message": "same" }
]
```

- eslint-plugin-boundaries: 패키지·레이어 매핑을 선언하면 위반이 에러가 된다.
- dependency-cruiser (CI): 순환 의존 금지 + core에 IO 의존성이 없는지 재확인.
- `platform/mock`: 모든 포트의 인메모리 구현. Playwright와 컴포넌트 테스트가 사용한다 — **모킹 라이브러리로 포트를 즉석에서 모킹하지 말 것** (계약이 흩어진다).
