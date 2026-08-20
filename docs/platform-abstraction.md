# Platform abstraction — develop on the web, ship as Tauri

> One rule: **ui code knows neither fetch, nor WebSocket, nor `@tauri-apps/*`. It knows only ports.**

This document is the complete answer to axes of change C1 (browser → Tauri) and C2 (implementations moving Node → Rust).

## 1. Why do it this way

- M0~M1 are developed in the browser: hot reload, DevTools, Playwright, no Rust toolchain needed.
- The goal is to put that code into a Tauri webview **without changing a single line.** For that to be possible, every point of contact with the "outside world" has to sit behind an interface.
- Scatter the contact points (fetch in every component) and the migration cost = grepping everything. Gather them and the migration cost = one implementation package.

## 2. The Platform facade and the ports

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

Port signature rules:

- Every method returns a `Promise` (even a synchronous implementation) — the signature does not change when an implementation becomes IPC.
- Streams are standardised as `subscribe(handler): Unsubscribe`. AsyncIterator is not used (React integration and teardown management are awkward).
- The input and output types of a port are all from `protocol`. Implementation details (Tauri's event names, WS frames) must never be exposed.
- Errors are normalised into `PlatformError { code, message, retryable }`. Implementation-specific exceptions are not thrown as they are.

## 3. Implementation matrix

| Port | `platform/web` (dev) | `platform/tauri` (prod) | Notes |
|---|---|---|---|
| agents | **WS → agent-host** | **the same WS client, reused** | The only one with a single implementation (the architecture §4 decision) |
| git | WS → host `dev-services/git` | Tauri invoke → Rust git2 | subject to C2 |
| fs | WS → host `dev-services/fs` | Tauri invoke → Rust | subject to C2 |
| store | WS → host `dev-services/store` (better-sqlite3) | Tauri invoke → rusqlite | subject to C2. **The schema is shared** (the DDL version is stated in protocol) |
| usage | WS → host `usage` | WS → host `usage` (the parser stays in the host) | Log parsing stays in Node — no gain from rewriting in Rust |
| system | web fallback (Notification API, no-op badge) | Tauri plugins | The UI degrades via capabilities |

The point: **most of the web implementation is "delegate to the host over WS."** So the web implementation is effectively one RPC client + a thin mapping per port, and the host's dev-services does the real work. At the Tauri migration, only dev-services has to move to Rust.

## 4. Bootstrap — the only place that knows an implementation

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

- We do **not** branch automatically by detecting the environment (whether `window.__TAURI__` exists) — the entry points differ, so detection is unnecessary, and detection logic becomes a hidden dependency.
- Components should rarely even use `usePlatform()` directly. Store actions (the store calls the ports) and selectors are enough for most cases.

## 5. Migration playbook (the execution order for C1, C2)

The Tauri migration is not a big bang but a **gradual, per-service migration**:

1. Create `apps/desktop`, have Tauri spawn agent-host as a sidecar (implement only the supervisor).
2. The first version of `createTauriPlatform()` = **reuse the web implementation as is** (everything delegated over WS). At this point the desktop app already runs — 0 lines of UI changed.
3. Replace the system port with Tauri plugins (notifications, badge, shortcuts, open in IDE). The capabilities flip to true and the UI features turn themselves on.

Steps 4~6 (moving git, store and fs to Rust) are **on hold** (2026-08-15).

In M1.5 the structure settled into Tauri supervising the Node sidecar as it is, and since the WS path is shared
by dev and prod, the practical benefit of the migration disappeared. M2 measurement found no bottleneck either (idle CPU 0%).
It is reopened **only when a performance problem is actually measured** — the port interface is the same, so moving it then still leaves the UI unchanged.
The fact as of now: `agent-host/dev-services` is the implementation for both dev and prod.

Each step is independently shippable, and if something goes wrong only that step is rolled back.

## 6. Enforcement — the rules are kept by machine

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

- eslint-plugin-boundaries: declare the package and layer mapping, then violations become errors.
- dependency-cruiser (CI): forbids circular dependencies + re-checks that core has no IO dependencies.
- `platform/mock`: an in-memory implementation of every port. Used by Playwright and component tests — **do not mock a port ad hoc with a mocking library** (it scatters the contract).
