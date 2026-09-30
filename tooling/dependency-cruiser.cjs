/** Forbids circular dependencies, plus a second line of defense for the layer rules (docs/architecture.md §6). */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      comment: 'A file nobody uses gets deleted. The only exception is something used in a way other than an import.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          'index\\.ts$',
          'main\\.tsx?$',
          // The bridge codex launches **directly** with `node <path>`. Having no import is
          // normal — the path is found at runtime by bridge-path.ts and copied into the bundle
          // by bundle.mjs.
          'adapters/codex/orchestrator-bridge\\.mjs$',
          // The screen-side entry point of the app runtime — esbuild bundles it out to the app
          // template's runtime/mcp-app.js (build-app-runtime.mjs).
          'agent-host/app-runtime/src/view\\.mjs$',
          // Files in the app template are used **by being copied into an app folder**
          // (scaffold.ts). Nothing imports them from inside the template itself.
          'agent-host/app-template/',
        ],
      },
      to: {},
    },
    /*
     * The app layer (#81): isolation here means not "complete" but **one-directional plus
     * ownership**, and that direction is enforced here rather than left to convention. An app
     * only touches the core through its pass (api/contract), and the only thing the core knows
     * about apps is a single line in the registry (and the contract types) — so that ripping an
     * app out leaves no scar on the core.
     */
    {
      name: 'ui-app-guest-pass',
      comment: 'The UI app runtime does not know this product\'s layers at all (#81 pass, #97 direction).',
      severity: 'error',
      // api.ts used to be the one exception that imported the store — that single line was
      // "the runtime does not run if the inbox is deleted". Now the pass delegates to the
      // surface host.ts declares, so there is no exception left.
      from: { path: '^packages/ui/src/apps/' },
      to: { path: '^packages/ui/src/(store|features|app)/' },
    },
    {
      name: 'ui-core-blind-to-apps',
      comment: 'All the UI core can take from apps is registry, contract and host (#81, #97).',
      severity: 'error',
      from: { path: '^packages/ui/src', pathNot: ['^packages/ui/src/apps/'] },
      to: { path: '^packages/ui/src/apps/', pathNot: ['^packages/ui/src/apps/(registry|contract|host)\\.tsx?$'] },
    },
    {
      name: 'host-app-guest-pass',
      comment: 'Inside a host app, nothing touches the core beyond what contract provides (#81).',
      severity: 'error',
      // The exception where contract.ts borrowed types from the orchestrator disappeared in
      // #97 — those types are now defined by contract.ts, and the orchestrator takes them from
      // there instead.
      from: { path: '^packages/agent-host/src/apps/', pathNot: ['^packages/agent-host/src/apps/external/'] },
      to: { path: '^packages/agent-host/src/(sessions|dev-services|adapters)/' },
    },
    /*
     * The external app runtime (M4 A) is not a guest but **the layer that carries guests**, so
     * one rule differs. Since external apps are folders and processes, the runtime has to keep
     * a few of the same OS promises the terminal and the command runner already keep: watching
     * a folder (watch), a path that never leaks outside its root (path-guard), and a shutdown
     * that finishes off descendants too (kill-tree).
     * Building two copies of those would repeat the same accident as having two versions of
     * "how do we kill a tree".
     *
     * So what is allowed is **narrowed by name** — only physical modules with no product
     * meaning. Sessions and adapters are still forbidden (a session is one caller of the
     * runtime, #97). The store is forbidden too: the runtime declares what it needs as
     * `ExternalAppsDeps` and the host fills it in. The built-in app (control) does not get this
     * exception.
     */
    {
      name: 'host-app-runtime-physics-only',
      comment: 'All the external app runtime can take from the core is the named physical modules (M4 A).',
      severity: 'error',
      from: { path: '^packages/agent-host/src/apps/external/' },
      to: {
        path: '^packages/agent-host/src/(sessions|dev-services|adapters)/',
        pathNot: ['^packages/agent-host/src/dev-services/(watch|path-guard|kill-tree)\\.ts$'],
      },
    },
    {
      name: 'host-core-blind-to-apps',
      comment: 'All the host core can take from apps is registry, contract, and the external app runtime\'s door (#81, M4 A).',
      severity: 'error',
      from: { path: '^packages/agent-host/src', pathNot: ['^packages/agent-host/src/apps/'] },
      // external/runtime.ts is the **one and only door** the external app runtime opens into
      // the core — discovery, processes and brokering behind it are unknown to the core. The
      // same spot registry occupies as the built-in app's single line.
      to: {
        path: '^packages/agent-host/src/apps/',
        pathNot: ['^packages/agent-host/src/apps/(registry|contract)\\.ts$', '^packages/agent-host/src/apps/external/runtime\\.ts$'],
      },
    },
    {
      name: 'core-no-io',
      comment: 'core is a pure domain — no IO.',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { path: '^(packages/(agent-host|ui|platform)/src|node_modules/(ws|better-sqlite3|react))' },
    },
    {
      name: 'ui-no-platform-impl',
      comment: 'ui takes only ports — no implementations.',
      severity: 'error',
      from: { path: '^packages/ui/src' },
      to: { path: '^packages/platform/src/(web|tauri|mock)' },
    },
    {
      name: 'host-no-frontend',
      comment: 'agent-host shares only protocol.',
      severity: 'error',
      from: { path: '^packages/agent-host/src' },
      to: { path: '^packages/(ui|core|platform)/src' },
    },
    {
      name: 'protocol-is-leaf',
      comment: 'protocol has zero dependencies (except zod).',
      severity: 'error',
      from: { path: '^packages/protocol/src' },
      to: { path: '^packages/(?!protocol)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // src-tauri/target and resources are Rust and bundle build output, so they are not parsed
    // (introduced in M2).
    exclude: {
      // app-template/runtime: a minified build artifact with nothing worth reading
      // (scripts/build-app-runtime.mjs).
      path: '(spike|dist|node_modules|src-tauri/(target|gen|resources)|adapters/codex/generated|app-template/runtime|\\.test\\.tsx?$)',
    },
    tsConfig: { fileName: 'tsconfig.json' },
    /*
     * A type-only import (`import type`) counts as a dependency too.
     * Without this, a file that only exports types (adapters/contract.ts) gets flagged as "a
     * file nobody uses" — when in reality six places use it. Once false warnings mix in, the
     * warnings stop being read.
     */
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
}
