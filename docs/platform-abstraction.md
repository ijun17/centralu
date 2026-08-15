# 플랫폼 추상화 — 웹으로 개발하고 Tauri로 출시한다

> 규칙 한 줄: **ui 코드는 fetch도, WebSocket도, `@tauri-apps/*`도 모른다. 포트만 안다.**

이 문서가 변경 축 C1(브라우저→Tauri), C2(Node→Rust 구현 이동)의 전체 답이다.

## 1. 왜 이렇게 하는가

- M0~M1을 브라우저에서 개발한다: 핫 리로드, DevTools, Playwright, Rust 툴체인 불필요.
- 그 코드를 **한 줄도 고치지 않고** Tauri 웹뷰에 넣는 게 목표다. 가능하려면 "외부 세계"와의 접점이 전부 인터페이스 뒤에 있어야 한다.
- 접점을 흩뿌리면(컴포넌트마다 fetch) 전환 비용 = 전체 grep. 접점을 모으면 전환 비용 = 구현 패키지 1개.

## 2. Platform 퍼사드와 포트

```ts
// platform/ports/platform.ts
export interface Platform {
  agents: AgentPort      // 세션 생성·전송·승인·중단 + 이벤트 구독
  git: GitPort           // status/log/branches/diff/checkout
  fs: FsPort             // 트리 lazy 목록, 파일 읽기, 워치
  store: StorePort       // 워크스페이스·세션·메시지·규칙 영속화
  usage: UsagePort       // 주간 집계 조회 (계산은 core, 원본 파싱은 host)
  system: SystemPort     // 알림, 뱃지, 전역 단축키, IDE로 열기, 파일 다이얼로그
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}

export interface PlatformCapabilities {
  osNotifications: boolean      // web: Notification API 제한적 / tauri: true
  dockBadge: boolean            // web: false / tauri: true
  globalShortcuts: boolean      // web: 창 포커스 내만 / tauri: true
  processSupervision: boolean   // web: false (host를 사용자가 띄움) / tauri: true
  openInIde: boolean            // web: false / tauri: true
}
```

포트 시그니처 규칙:

- 모든 메서드는 `Promise` 반환 (동기 구현이라도) — 구현이 IPC로 바뀌어도 시그니처 불변.
- 스트림은 `subscribe(handler): Unsubscribe` 형태로 통일. AsyncIterator는 쓰지 않는다(React 통합·해제 관리가 번거로움).
- 포트의 입출력 타입은 전부 `protocol`의 것. 구현 세부(예: Tauri의 이벤트 이름, WS 프레임)는 절대 노출 금지.
- 에러는 `PlatformError { code, message, retryable }`로 정규화. 구현별 예외를 그대로 던지지 않는다.

## 3. 구현 매트릭스

| 포트 | `platform/web` (dev) | `platform/tauri` (prod) | 비고 |
|---|---|---|---|
| agents | **WS → agent-host** | **동일한 WS 클라이언트 재사용** | 유일하게 구현이 하나 (architecture §4 결정) |
| git | WS → host `dev-services/git` | Tauri invoke → Rust git2 | C2 대상 |
| fs | WS → host `dev-services/fs` | Tauri invoke → Rust | C2 대상 |
| store | WS → host `dev-services/store` (better-sqlite3) | Tauri invoke → rusqlite | C2 대상. **스키마는 공유** (protocol에 DDL 버전 명시) |
| usage | WS → host `usage` | WS → host `usage` (파서는 host에 남는다) | 로그 파싱은 Node 유지 — Rust 재작성 이득 없음 |
| system | 웹 폴백 (Notification API, no-op 뱃지) | Tauri 플러그인 | capability로 UI가 격하 |

포인트: **web 구현의 대부분은 "WS로 host에 위임"이다.** 그래서 web 구현은 사실상 RPC 클라이언트 하나 + 포트별 얇은 매핑이고, host의 dev-services가 실제 일을 한다. Tauri 전환 때 dev-services만 Rust로 옮기면 된다.

## 4. 부트스트랩 — 구현체를 아는 유일한 곳

```ts
// apps/web/src/main.tsx
const platform = await createWebPlatform({
  hostUrl: import.meta.env.VITE_HOST_URL ?? 'ws://127.0.0.1:5175',
  token: import.meta.env.VITE_HOST_TOKEN,
})
createRoot(el).render(<App platform={platform} />)

// apps/desktop/src/main.tsx  (M1 이후)
const platform = await createTauriPlatform()   // 내부에서 sidecar 정보를 invoke로 조회 후 WS 연결
createRoot(el).render(<App platform={platform} />)
```

```tsx
// ui/app/PlatformProvider.tsx — ui가 Platform을 받는 유일한 통로
const PlatformContext = createContext<Platform | null>(null)
export const usePlatform = () => { /* null 체크 후 반환 */ }
export const useCapability = (k: keyof PlatformCapabilities) => usePlatform().capabilities[k]
```

- 환경 감지(`window.__TAURI__` 유무)로 자동 분기하지 **않는다** — 진입점이 다르므로 감지가 불필요하고, 감지 로직은 숨은 의존이 된다.
- 컴포넌트는 `usePlatform()`조차 직접 쓰는 일이 드물어야 한다. 대부분은 스토어 액션(스토어가 포트 호출)과 셀렉터로 충분하다.

## 5. 마이그레이션 플레이북 (C1, C2 실행 순서)

Tauri 전환은 빅뱅이 아니라 **서비스 단위 점진 전환**이다:

1. `apps/desktop` 생성, Tauri가 agent-host를 사이드카로 spawn (수퍼바이저만 구현).
2. `createTauriPlatform()` 1차 버전 = **web 구현 그대로 재사용** (전부 WS 위임). 이 시점에 이미 데스크톱 앱이 돈다 — UI 변경 0줄.
3. system 포트를 Tauri 플러그인으로 교체 (알림·뱃지·단축키·IDE 열기). capability가 true로 바뀌며 UI 기능이 저절로 켜진다.
4~6단계(git·store·fs를 Rust로 이관)는 **보류 상태다** (2026-08-15).

M1.5에서 Tauri가 Node 사이드카를 그대로 감독하는 구조로 굳었고, WS 경로가 dev·prod 공용이라
이관의 실익이 사라졌다. M2 측정에서도 병목은 나오지 않았다 (유휴 CPU 0%).
**성능 문제가 실제로 측정될 때만** 다시 꺼낸다 — 포트 인터페이스가 같으므로 그때 옮겨도 UI는 그대로다.
지금 시점의 사실: `agent-host/dev-services`가 dev와 prod 모두의 구현이다.

각 단계가 독립 배포 가능하고, 문제가 생기면 그 단계만 되돌린다.

## 6. 강제 장치 — 규칙은 기계가 지킨다

```jsonc
// eslint: ui 패키지에 적용
"no-restricted-imports": ["error", { "patterns": [
  { "group": ["@tauri-apps/*"], "message": "platform/tauri에서만" },
  { "group": ["@control-center/platform/web", "@control-center/platform/tauri"],
    "message": "ui는 ports만. 구현 주입은 apps 진입점에서" }
]}],
"no-restricted-globals": ["error",
  { "name": "fetch", "message": "ui에서 네트워크 직접 호출 금지 — 포트를 거쳐라" },
  { "name": "WebSocket", "message": "동일" }
]
```

- eslint-plugin-boundaries: 패키지·레이어 매핑 선언 후 위반을 에러로.
- dependency-cruiser(CI): 순환 의존 금지 + core의 IO 의존 금지 재검증.
- `platform/mock`: 전 포트의 인메모리 구현. Playwright와 컴포넌트 테스트가 사용 — **모킹 라이브러리로 포트를 즉석 모킹하지 말 것** (계약이 흩어진다).
