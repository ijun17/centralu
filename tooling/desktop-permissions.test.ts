import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'

/**
 * Permissions for our app commands (#143, spike S-2).
 *
 * Without an app manifest, Tauri **lets an app command from a local origin through with no
 * permission check at all** (tauri 2.11.5 webview/mod.rs `on_message`). Under that, a page on
 * a local origin, from any window or frame, can call any of our commands, and the only thing
 * standing in the way is the invoke key, which changes on every run. Whenever that key is
 * wrong, Tauri writes it to stderr verbatim. So build.rs generates a permission for every
 * command (`AppManifest::commands`), and capabilities/default.json grants those permissions
 * only to the local origin of window `main`. This checks that the three agree with each other,
 * and with the commands the screen actually calls.
 *
 * - The manifest has to equal `invoke_handler`. A command only in the manifest has a
 *   permission with no handler; a command only in the handler has no permission at all. A
 *   command with no permission is refused even from the main window.
 * - What is granted has to equal what the screen calls. Granting more only widens the surface
 *   an app screen frame could aim at; granting less breaks the screen.
 * - No `remote` exists. A `remote` permission grants permissions to pages from that origin.
 *   Since an app screen is a loopback http frame, a `remote` covering 127.0.0.1 would let an
 *   app screen frame call our commands.
 *
 * The values measured in the window live in the #143 commit. The main frame got all 12
 * answered. The loopback frame was refused with `allowed on: [windows: "main", URL: local] …
 * permission: allow-<command>` even holding the real key.
 */

const TAURI = 'apps/desktop/src-tauri'
const url = (p: string) => new URL(`../${p}`, import.meta.url)
const read = (p: string) => readFileSync(url(p), 'utf8')
/** Every file under a directory (as a `/` path relative to that directory; recursive readdir answers `\` on Windows). */
const files = (dir: string) =>
  (readdirSync(url(dir), { recursive: true }) as string[])
    .map((f) => f.split('\\').join('/'))
    .filter((f) => statSync(url(`${dir}/${f}`)).isFile())
    .sort()
/** Strips Rust comments — so a name or bracket inside a comment is not read as part of a list. */
const stripRustComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
/** Command name → permission name (tauri-utils 2.9.3 acl/build.rs `autogenerate_command_permissions`). */
const allow = (command: string) => `allow-${command.replaceAll('_', '-')}`

/** The commands written in lib.rs's `invoke_handler(tauri::generate_handler![…])`. */
function registered(): string[] {
  const calls = [...stripRustComments(read(`${TAURI}/src/lib.rs`)).matchAll(/\.invoke_handler\(\s*tauri::generate_handler!\[([^\]]*)\]\s*\)/g)]
  expect(calls, 'exactly one invoke_handler(tauri::generate_handler![…]) in lib.rs').toHaveLength(1)
  return calls[0]![1]!.split(',').map((s) => s.trim()).filter(Boolean)
}

/** The commands written in build.rs's `AppManifest::new().commands(&[…])`. */
function manifest(): string[] {
  const code = stripRustComments(read(`${TAURI}/build.rs`))
  // Even with the list present, it is not a manifest unless it is handed to tauri-build.
  expect(code).toMatch(/tauri_build::try_build\(/)
  expect(code).toMatch(/\.app_manifest\(/)
  expect(code).not.toMatch(/tauri_build::build\(\)/)
  const lists = [...code.matchAll(/AppManifest::new\(\)\s*\.commands\(\s*&\[([^\]]*)\]\s*\)/g)]
  expect(lists, 'exactly one AppManifest::new().commands(&[…]) in build.rs').toHaveLength(1)
  return [...lists[0]![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

/**
 * The app commands the screen calls. Only these two packages depend on `@tauri-apps/api`
 * (enforced by a test below), so these two are also the only places `invoke('…')` could exist.
 */
const CALLER_DIRS = ['apps/desktop/src', 'packages/platform/src']
function calledFromUi(): string[] {
  const out = new Set<string>()
  for (const dir of CALLER_DIRS) {
    for (const f of files(dir)) {
      if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue
      // invoke('x') · invoke<T>('x') · invoke<A<B>>('x')
      for (const m of read(`${dir}/${f}`).matchAll(/\binvoke\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\(\s*['"`]([\w-]+)['"`]/g)) out.add(m[1]!)
    }
  }
  return [...out].sort()
}

type Permission = string | { identifier: string }
type Capability = {
  identifier: string
  windows?: string[]
  webviews?: string[]
  local?: boolean
  remote?: unknown
  platforms?: string[]
  permissions: Permission[]
}
const CAP_DIR = `${TAURI}/capabilities`
function capabilities(): [string, Capability][] {
  return files(CAP_DIR).map((f) => [f, JSON.parse(read(`${CAP_DIR}/${f}`)) as Capability])
}
const idOf = (p: Permission) => (typeof p === 'string' ? p : p.identifier)
/** A permission with no prefix (`plugin:`) belongs to the app manifest (tauri-utils acl/resolved.rs `get_prefix().unwrap_or(APP_ACL_KEY)`). */
const isAppPermission = (id: string) => !id.includes(':')

/** What is only in a — so the failure message names what did not match. */
const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x)).sort()
const repeated = (a: string[]) => a.filter((x, i) => a.indexOf(x) !== i)

describe('app command permissions (#143)', () => {
  it('the manifest equals the commands registered in invoke_handler', () => {
    const m = manifest()
    const r = registered()
    expect(repeated(m), 'a command listed twice in the manifest').toEqual([])
    expect({ handlerWithoutPermission: minus(r, m), permissionWithoutHandler: minus(m, r) }).toEqual({
      handlerWithoutPermission: [],
      permissionWithoutHandler: [],
    })
  })

  it('there is exactly one permission file per manifest command, and no others', () => {
    // build.rs is a build artifact rewritten on every build, but it is committed (matching the
    // Tauri example app). Removing a command does not delete the old file, and every file
    // under `permissions/` is read as an app permission.
    const want = manifest().map((c) => `autogenerated/${c}.toml`)
    const have = files(`${TAURI}/permissions`)
    expect({ stray: minus(have, want), missing: minus(want, have) }).toEqual({ stray: [], missing: [] })
  })

  it('every app command the screen calls is registered', () => {
    const called = calledFromUi()
    expect(called.length).toBeGreaterThan(0)
    expect({ calledButNotRegistered: minus(called, registered()) }).toEqual({ calledButNotRegistered: [] })
  })

  it('the only app permissions granted are allow-<command> for what the screen calls', () => {
    const granted = capabilities().flatMap(([, c]) => c.permissions.map(idOf).filter(isAppPermission))
    const needed = calledFromUi().map(allow)
    expect(repeated(granted), 'an app permission granted twice').toEqual([])
    expect({ grantedButNotCalled: minus(granted, needed), calledButNotGranted: minus(needed, granted) }).toEqual({
      grantedButNotCalled: [],
      calledButNotGranted: [],
    })
  })

  it('app permissions are granted only to the local origin of window main', () => {
    const granting = capabilities().filter(([, c]) => c.permissions.map(idOf).some(isAppPermission))
    expect(granting.length).toBeGreaterThan(0)
    for (const [f, c] of granting) {
      expect(c.windows, f).toEqual(['main'])
      expect(c.webviews ?? [], f).toEqual([])
      expect(c.local, f).not.toBe(false)
      expect(c.remote, f).toBeUndefined()
      expect(c.platforms, `${f}: narrowing the platforms breaks the screen on every other OS`).toBeUndefined()
    }
  })
})

describe('window permission boundary (S-2)', () => {
  it('no capability has remote — if one did, an app screen frame from that origin would gain the permission', () => {
    const caps = capabilities()
    expect(caps.length).toBeGreaterThan(0)
    for (const [f, c] of caps) expect(c.remote, f).toBeUndefined()
  })

  it('windows and webviews are never selected with a wildcard', () => {
    for (const [f, c] of capabilities()) {
      expect([...(c.windows ?? []), ...(c.webviews ?? [])].filter((w) => w.includes('*')), f).toEqual([])
    }
  })

  it('there is no capability this test cannot see — only JSON files, none inside config files', () => {
    // tauri-build reads under capabilities/ recursively (JSON, JSON5, TOML), and also reads
    // whatever is written in tauri.conf.json's app.security.capabilities. This test only reads
    // the JSON files here.
    expect(files(CAP_DIR).filter((f) => !f.endsWith('.json'))).toEqual([])
    for (const conf of ['tauri.conf.json', 'tauri.linux.conf.json']) {
      const c = JSON.parse(read(`${TAURI}/${conf}`)) as { app?: { security?: { capabilities?: unknown } } }
      expect(c.app?.security?.capabilities, conf).toBeUndefined()
    }
  })

  it('apps/desktop and packages/platform are the only packages depending on @tauri-apps/api — the scope this test searches for screen calls', () => {
    const deps = (dir: string) => {
      const pkg = JSON.parse(read(`${dir}/package.json`)) as Record<string, Record<string, string> | undefined>
      return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    }
    const users = ['apps', 'packages']
      .flatMap((root) => readdirSync(url(root)).map((d) => `${root}/${d}`))
      .filter((dir) => {
        try {
          return '@tauri-apps/api' in deps(dir)
        } catch {
          return false // a directory with no package.json
        }
      })
    expect(users.sort()).toEqual(['apps/desktop', 'packages/platform'])
    expect(CALLER_DIRS.map((d) => d.replace(/\/src$/, '')).sort()).toEqual(users.sort())
  })
})

/**
 * The permissions plugins open (#186, M4 E-4). The tests above check app command permissions
 * against the commands the screen calls; there is no equivalent call site to check plugin
 * permissions against (they are called by the webview's `@tauri-apps/plugin-*`), so what is
 * granted is written here **by name**. Adding a plugin or widening a permission means editing
 * this list — so something like the deep-link plugin opening a scheme-registration command to
 * the webview cannot slip in quietly.
 */
describe('plugin permissions (#186)', () => {
  it('the plugin permissions granted are exactly this list', () => {
    const granted = capabilities()
      .flatMap(([, c]) => c.permissions.map(idOf))
      .filter((id) => !isAppPermission(id))
      .sort()
    expect(granted).toEqual(
      [
        'core:default',
        'core:window:allow-start-dragging',
        'core:window:allow-set-focus',
        'core:window:allow-show',
        'core:window:allow-unminimize',
        // The theme (#312): System mode hands the window's appearance back to the OS, and the
        // window's own background follows the floor colour
        'core:window:allow-set-theme',
        'core:window:allow-set-background-color',
        'notification:default',
        'global-shortcut:allow-register',
        'global-shortcut:allow-unregister',
        'global-shortcut:allow-is-registered',
        'dialog:default',
        'opener:default',
        // Widened by one scoped entry, checked below
        'opener:allow-open-url',
      ].sort(),
    )
  })

  /*
   * `opener:default` opens http(s), mailto and tel links. The one scheme added beside them is VS Code's Remote-SSH
   * link, for a project on a linked machine (#82, docs/plans/remote-hub.md §6): `vscode://vscode-remote/ssh-remote+`
   * and nothing else of VS Code's (not `vscode://file/`, which opens a local path, nor an extension's handler).
   */
  it('the only URLs opened beyond the default ones are VS Code Remote-SSH links', () => {
    const scoped = capabilities().flatMap(([, c]) =>
      c.permissions.filter((p): p is { identifier: string; allow?: { url?: string }[]; deny?: unknown } => typeof p !== 'string'),
    )
    expect(scoped.map((p) => p.identifier)).toEqual(['opener:allow-open-url'])
    expect(scoped[0]!.allow).toEqual([{ url: 'vscode://vscode-remote/ssh-remote+*' }])
    expect(scoped[0]!.deny).toBeUndefined()
  })
})

/**
 * App links, `centralu://app?url=…` (M4 E-4). One scheme is registered in Info.plist, and a
 * link is received through the OS's open event (`RunEvent::Opened`). The deep-link plugin is
 * not used: receiving that same event through the plugin would open more commands to the
 * webview. What is added to the webview is a single app command, `take_app_links`, that pulls
 * out the queued links, and its permission is checked against the other commands by the same
 * tests above.
 */
describe('app links (M4 E-4)', () => {
  it('the only registered URL scheme is centralu', () => {
    const plist = read(`${TAURI}/Info.plist`).replace(/<!--[\s\S]*?-->/g, '')
    const lists = [...plist.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g)]
    const schemes = lists.flatMap((m) => [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((s) => s[1]))
    expect(schemes).toEqual(['centralu'])
    // If a config file pointed at a separate plist, something other than this file would get
    // merged in — what this test sees has to be what ends up in the bundle.
    for (const conf of ['tauri.conf.json', 'tauri.linux.conf.json']) {
      const c = JSON.parse(read(`${TAURI}/${conf}`)) as { bundle?: { macOS?: { infoPlist?: unknown } }; plugins?: Record<string, unknown> }
      expect(c.bundle?.macOS?.infoPlist, conf).toBeUndefined()
      expect(c.plugins?.['deep-link'], conf).toBeUndefined()
    }
  })

  it('there is no deep-link plugin — not in dependencies, not in permissions', () => {
    expect(stripRustComments(read(`${TAURI}/Cargo.toml`).replace(/#[^\n]*/g, ''))).not.toMatch(/tauri-plugin-deep-link/)
    for (const dir of ['apps/desktop', 'packages/platform']) {
      expect(read(`${dir}/package.json`), dir).not.toMatch(/plugin-deep-link/)
    }
    for (const [f, c] of capabilities()) expect(c.permissions.map(idOf).filter((id) => id.startsWith('deep-link:')), f).toEqual([])
  })

  it('the command that pulls out links is registered, the screen calls it, and its permission is only on window main', () => {
    expect(registered()).toContain('take_app_links')
    expect(calledFromUi()).toContain('take_app_links')
    const granting = capabilities().filter(([, c]) => c.permissions.map(idOf).includes('allow-take-app-links'))
    expect(granting.map(([, c]) => c.windows)).toEqual([['main']])
  })
})
