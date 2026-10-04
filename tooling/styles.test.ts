/**
 * The L5-1 visual-regression floor (docs/plans/m1.5-plan.md verification protocol).
 *
 * Background: Tailwind v4's automatic source detection once failed to find the monorepo's
 * packages/ui, and **all 16 E2E tests passed even though the CSS was entirely empty.**
 * A behavior test never looks at class names, so this category of failure can never be caught
 * that way. So this checks directly whether the build output actually contains styles.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** If any of these classes go missing, the screen falls apart — chosen to each represent a
 * different source. */
const REQUIRED = [
  { needle: '--color-surface-floor', why: '@theme token (the palette itself)' },
  { needle: '.keycap', why: '@layer components (a signature element)' },
  { needle: 'bg-surface-floor', why: 'a utility used by packages/ui components' },
  { needle: 'text-ink-muted', why: 'text hierarchy' },
  { needle: 'border-line', why: 'a border' },
  // The two below check that a "color allowed as an exception" actually made it into the
  // build output. If only the token is declared and no utility is generated, a diff is drawn
  // with no background — a category that a behavior test can never catch (E2E does not look
  // at class names).
  { needle: 'bg-diff-add-bg', why: 'a diff addition background (chromatic exception)' },
  /*
   * Tailwind writes a theme variable into the build only when it sees it used somewhere. The
   * terminal's colours are read by script alone (components/terminalTheme.ts), so if that file
   * stopped spelling a name out, the variable would vanish and xterm would quietly paint its own
   * defaults. Shadows are reached only through `shadow-(--shadow-…)`, the same kind of use.
   */
  { needle: '--color-term-bg', why: 'a token only script reads (the terminal theme)' },
  { needle: '--color-term-bright-white', why: 'the last ANSI colour, the same' },
  { needle: '--shadow-modal', why: 'a shadow token reached through shadow-(--shadow-modal)' },
  { needle: 'cc-orbit', why: 'the spinning working-state border (@property + @keyframes)' },
  { needle: 'cc-chip', why: 'the inner shadow on a session marker chip (@layer components)' },
]

let css = ''
let jsBytes = 0
let outDir = ''

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'cc-css-'))
  // vite's own entry through this Node: `pnpm` is a .cmd on Windows, which execFile cannot start (#14)
  execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: join(ROOT, 'apps/web'),
    stdio: 'pipe',
    /*
     * Measures the build that actually ships. vitest sets NODE_ENV=test, and the child process
     * inherits that, which makes vite load React's development build instead. Measured
     * (988713e): the same source was 1,468,860B under test and 1,160,527B in production. The
     * budget below has to measure the size that reaches the person.
     */
    env: { ...process.env, NODE_ENV: 'production' },
  })
  const assets = join(outDir, 'assets')
  // There can be more than one CSS chunk — checking only one would let a lazily loaded chunk
  // slip past the gate.
  const files = readdirSync(assets).filter((f) => f.endsWith('.css'))
  expect(files.length, 'no CSS file in the build output').toBeGreaterThan(0)
  css = files.map((f) => readFileSync(join(assets, f), 'utf8')).join('\n')
  jsBytes = readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .reduce((n, f) => n + readFileSync(join(assets, f)).length, 0)
}, 120_000)

afterAll(() => {
  if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
})

describe('the built CSS actually contains styles', () => {
  it.each(REQUIRED)('$needle — $why', ({ needle }) => {
    expect(css).toContain(needle)
  })

  it('is not down at the level of only default styles (under 4KB)', () => {
    // This was the exact size when source detection failed (preflight alone is 4.19KB).
    expect(css.length).toBeGreaterThan(8_000)
  })

  /**
   * A chromatic color is allowed **only if it is listed here.**
   *
   * The policy: this started with every color stripped out, and from here on colors are
   * **added back one at a time, each with a reason.** The bar is not "does it look nicer" but
   * **does it touch the brightness hierarchy** — since "the brightest thing on screen = the
   * thing waiting for me" has to hold true always, nothing that speaks to state or urgency is
   * allowed to carry color. The exceptions below sit **outside** that hierarchy:
   *
   * This check only looks at **CSS**. A color that arrives through a separate file (for
   * example a file-type icon SVG — vscode-icons, MIT) is not caught here. That is an
   * intentional exception, since those are pictures that communicate a category and do not
   * overlap with the brightness hierarchy — but the fact that it is outside this check's scope
   * still has to be known.
   *
   *   - diff addition/deletion (diff-add/diff-del): judging an approval is something done at a glance,
   *     and green and red go past a learned convention into something close to reflex. In
   *     exchange, they never leave the body of a diff.
   *   - danger: the deletion red, borrowed for what destroys something or failed (same values).
   *   - the terminal's 16 ANSI colours (term-*): a program's own output, xterm's default palette.
   *     They were always in the app inside xterm's script; they are written out as tokens so a
   *     theme can change them, and they never leave the terminal.
   *   - the orbit ring (cc-orbit): the border that speaks "working" through rotation.
   *     Saturation is raised, but lightness is held down so it **never gets brighter than pure
   *     white (ink-signal)** — the top of the brightness scale belongs to waiting.
   *
   * A chromatic color not on this list fails the build — widening the exception means writing
   * the reason here.
   *
   * **If the policy changes, revisit the decisions recorded here.** The orbit color is the
   * example: it was held down for a reason that belonged to the monochrome era, and after the
   * policy changed nobody went back to look, until the person asked "did you take the color
   * out?" That is how it was found. This list is both a record of what is allowed and **a list
   * of things to revisit.**
   */
  it('the palette is monochrome (R=G=B) outside the allowed exceptions', () => {
    const ALLOWED = new Set([
      '7ee787', '10251a', // diff addition
      'ffa198', '2b1517', // diff deletion, and danger
      // The terminal's ANSI palette (xterm's defaults, see --color-term-* in index.css)
      '2e3436', 'cc0000', '4e9a06', 'c4a000', '3465a4', '75507b', '06989a', 'd3d7cf',
      '555753', 'ef2929', '8ae234', 'fce94f', '729fcf', 'ad7fa8', '34e2e2', 'eeeeec',
      // The orbit ring — the border that speaks "working" through rotation.
      // It was first held down to almost pure white, then raised to a real color once the
      // color policy changed to "add conservatively". The line it keeps: **never brighter
      // than pure white** (the spinning ring speaks to state, so it lives inside the
      // brightness hierarchy, and the top of that hierarchy belongs to waiting).
      '2d6cf0', '7b3fe4', 'd63aa8', 'ff8a3d', '4ad6d0',
    ])
    const hexes = [...css.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1]!.toLowerCase())
    const chromatic = hexes.filter((h) => {
      const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)]
      return !(r === g && g === b) && !ALLOWED.has(h)
    })
    expect([...new Set(chromatic)]).toEqual([])
  })
})

/**
 * A class we wrote ourselves only means something **if it is actually used.**
 *
 * The CSS check above passes as long as the rule exists in `@layer components` — unlike a
 * utility, it always lands in the build output regardless of whether anything uses it. So a
 * class could be defined and never actually attached to a component, and this would still be
 * green (this actually happened with cc-chip: it was in the CSS, attached to nothing, and the
 * only reason it was found was the person asking "why didn't this change?").
 *
 * "Applied" only holds once both are true: it is in the build output, and the source uses it.
 */
describe('our own classes are actually used', () => {
  const OURS = ['cc-chip', 'cc-orbit']
  const src = execFileSync('grep', ['-rl', '--include=*.tsx', '--include=*.ts', '-e', 'cc-', 'packages/ui/src'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((f) => readFileSync(join(ROOT, f), 'utf8'))
    .join('\n')

  it.each(OURS)('%s — is attached to a component', (name) => {
    expect(src, `${name} exists only in CSS and is not attached anywhere`).toContain(name)
  })
})

/**
 * The type and radius scales hold (#312 step 2).
 *
 * Tailwind's own scales are cleared in index.css, so a size or radius that is not a token can only
 * come back as an arbitrary value (`text-[9px]`, `rounded-[5px]`). That is exactly how the app
 * had drifted to nine text sizes and ten radii, one call site at a time. The few arbitrary values
 * that are allowed say why where they are written: rows of a fixed height that a virtual list
 * or a drawn lane depends on, and a radius derived from a token.
 */
describe('type and radius stay on the scale', () => {
  const ALLOWED = new Set([
    'leading-[18px]', // CodeViewer: the virtual list's row height
    'leading-[1.5]', // GitPanel's diff: the virtual list's ~17px rows
    'rounded-b-[calc(var(--radius-lg)-1px)]', // the folded composer inside the pane's 1px border
  ])
  const files = execFileSync('git', ['ls-files', 'packages/ui/src', 'apps/web/src', 'apps/desktop/src'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))

  it('no arbitrary text size, line height or radius outside the listed exceptions', () => {
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      for (const m of text.matchAll(/(?<![\w-])(?:text|leading|rounded(?:-[trblse]{1,2})?)-\[[^\]\s]+\]/g)) {
        // text-[…] is also how a colour is written arbitrarily; only sizes are the scale's business
        if (m[0].startsWith('text-[') && !/^text-\[[\d.]+(px|rem|em)\]$/.test(m[0])) continue
        if (!ALLOWED.has(m[0])) offenders.push(`${f}: ${m[0]}`)
      }
      for (const m of text.matchAll(/fontSize: ['"`]?\d/g)) offenders.push(`${f}: ${m[0]}`)
    }
    expect(offenders, 'use a token from the scale in styles/index.css, or add the exception here with its reason').toEqual([])
  })
})

describe('bundle regression (decision C-3: no editor engine in the viewer)', () => {
  it('CodeMirror and Shiki are not in the bundle', () => {
    // An editor engine is overkill for a read-only viewer. Including one would require lazy
    // loading as a precondition, and Shiki's default engine is WASM, which conflicts with the
    // Tauri CSP too (on the tech-stack ban list).
    expect(css).not.toMatch(/cm-editor|shiki/i)
  })

  it('the app\'s total JS does not exceed 1.5MB', () => {
    // 1.31MB in the release build (measured at M4 B-3c, including lazy-loaded chunks). It was
    // 1.16MB at 988713e, and the app screen's bridge (ext-apps app-bridge, 138KB loaded the
    // first time a screen opens) has been added since. Crossing this line means a heavy
    // dependency came in, so raise it with a reason recorded.
    expect(jsBytes).toBeLessThan(1_500_000)
  })
})

/**
 * The Tauri permission gate.
 *
 * E2E uses a mock that runs in the browser, so it **can never catch a missing Tauri
 * permission.** This was exactly why window dragging came back "does not work" three times in
 * a row: `core:window:default` is a read-only bundle with no `allow-start-dragging`, and under
 * that both data-tauri-drag-region and startDragging() are silently refused.
 *
 * So this checks the window features the code calls against the permission file.
 */
describe('Tauri permissions', () => {
  const capability = JSON.parse(
    readFileSync(join(ROOT, 'apps/desktop/src-tauri/capabilities/default.json'), 'utf8'),
  ) as { permissions: string[] }

  /**
   * Checks the native features the code calls against the permissions.
   *
   * This category has been missed twice: window dragging (core:window:allow-start-dragging)
   * and the global shortcut (global-shortcut:*). Both were assumed to be part of the
   * `…:default` bundle, and neither was — window:default is read-only, and
   * global-shortcut:default **turns nothing on** ("shortcuts can be inherently dangerous").
   * The symptom is silent inaction, so E2E (the browser mock) can never catch it.
   */
  const NATIVE_CALLS: { pattern: RegExp; permission: string; files: string[]; what: string }[] = [
    {
      pattern: /startDragging\(/,
      permission: 'core:window:allow-start-dragging',
      files: ['packages/platform/src/tauri/index.ts'],
      what: 'window dragging',
    },
    {
      pattern: /\bregister\(/,
      permission: 'global-shortcut:allow-register',
      files: ['apps/desktop/src/main.tsx'],
      what: 'registering the global shortcut',
    },
    {
      pattern: /isRegistered\(/,
      permission: 'global-shortcut:allow-is-registered',
      files: ['apps/desktop/src/main.tsx'],
      what: 'checking the global shortcut',
    },
  ]

  it.each(NATIVE_CALLS)('$what: if the code calls it, the permission exists too', ({ pattern, permission, files }) => {
    const used = files.some((f) => pattern.test(readFileSync(join(ROOT, f), 'utf8')))
    if (!used) return // Not used, so no permission is needed either.
    expect(capability.permissions).toContain(permission)
  })

  it('does not rely on a default bundle that turns nothing on', () => {
    // Being named default does not mean it contains what is needed (caught twice by measurement).
    expect(capability.permissions).not.toContain('global-shortcut:default')
  })

  /**
   * The top bar's height has to carry the same value in **three places**.
   *
   *   1. App.tsx's h-* (the height the screen actually draws)
   *   2. tauri.conf.json's trafficLightPosition.y (the position before the first frame)
   *   3. traffic_lights.rs's HEADER_H (the value that keeps it in place after that)
   *
   * The reason all three exist is that starting with macOS 26, the window manager no longer
   * settles the button position synchronously with a resize — the setting alone would let the
   * window snap back to its default spot as it appears. So the setting owns the first frame,
   * and Rust owns everything after it.
   *
   * Fixing only one of them looks wrong with no error at all (and it actually did drift that
   * way once). E2E runs in a browser and cannot see the traffic lights, so this checks all
   * three values against each other here instead.
   */
  it('the top bar height agrees across the config, Rust and the screen', () => {
    const header = readFileSync(join(ROOT, 'packages/ui/src/app/App.tsx'), 'utf8')
    const m = /className="flex h-(\d+) shrink-0 items-center gap-4 border-b border-line bg-surface-side/.exec(header)
    expect(m, 'could not find the top bar\'s h-* class').toBeTruthy()
    const barPx = Number(m![1]) * 4 // tailwind h-9 = 36px
    const BUTTON = 12 // the diameter of a macOS traffic light

    const conf = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: { trafficLightPosition?: { x: number; y: number } }[] } }
    const pos = conf.app.windows[0]!.trafficLightPosition
    expect(pos, 'with no trafficLightPosition, the first frame starts at the default spot').toBeTruthy()
    expect(pos!.y).toBe((barPx - BUTTON) / 2)

    const rust = readFileSync(join(ROOT, 'apps/desktop/src-tauri/src/traffic_lights.rs'), 'utf8')
    const h = /const HEADER_H: f64 = ([\d.]+);/.exec(rust)
    expect(h, 'could not find HEADER_H in traffic_lights.rs').toBeTruthy()
    expect(Number(h![1])).toBe(barPx)

    const x = /const INSET_X: f64 = ([\d.]+);/.exec(rust)
    expect(Number(x![1]), 'if the config and Rust disagree on x, it jumps sideways on the first frame').toBe(pos!.x)
  })

  it('the webview does not intercept an OS drop (kills file attachments)', () => {
    const conf = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: { dragDropEnabled?: boolean }[] } }
    expect(conf.app.windows[0]!.dragDropEnabled).toBe(false)
  })
})

/**
 * Linux packaging (issue #14).
 *
 * None of this can be run from a Mac, and a wrong bundle config does not fail until a
 * CI job has spent minutes compiling Rust. These are the parts that are checkable from
 * here: that the Linux config exists and is separate, and that every icon it names is
 * actually on disk — a missing icon path is the classic way a Linux bundle dies at the
 * very last step of the build.
 */
describe('Linux bundle configuration', () => {
  const base = JSON.parse(
    readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  ) as { bundle: { targets: string[]; icon: string[] } }
  const linux = JSON.parse(
    readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.linux.conf.json'), 'utf8'),
  ) as { bundle: { targets: string[]; icon: string[] } }

  it('does not touch the Mac bundle', () => {
    // Tauri merges tauri.linux.conf.json over the base one and only on Linux. Putting
    // the Linux targets in the shared file instead would have made `tauri build` on a
    // Mac try to produce a .deb.
    expect(base.bundle.targets).toEqual(['app', 'dmg'])
  })

  it('builds a deb and an appimage', () => {
    expect(linux.bundle.targets).toEqual(['deb', 'appimage'])
  })

  it('every icon the config points at actually exists', () => {
    for (const icon of linux.bundle.icon) {
      expect(existsSync(join(ROOT, 'apps/desktop/src-tauri', icon)), `${icon} is missing`).toBe(true)
    }
  })
})

/**
 * Windows (#14). tauri-build embeds the first `.ico` in `bundle.icon` (or `icons/icon.ico`)
 * into the executable and fails the build outright when it is missing, `tauri dev` included —
 * it never converts from PNG. And the bundler keeps only msi/nsis on Windows, so the base
 * `["app", "dmg"]` would filter to nothing: no error, no installer.
 */
describe('Windows bundle configuration', () => {
  const windows = JSON.parse(
    readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.windows.conf.json'), 'utf8'),
  ) as { bundle: { targets: string[]; icon: string[] } }

  it('builds an NSIS installer', () => {
    expect(windows.bundle.targets).toEqual(['nsis'])
  })

  it('names an .ico that exists', () => {
    const ico = windows.bundle.icon.find((icon) => icon.endsWith('.ico'))
    expect(ico, 'no .ico in bundle.icon').toBeDefined()
    for (const icon of windows.bundle.icon) {
      expect(existsSync(join(ROOT, 'apps/desktop/src-tauri', icon)), `${icon} is missing`).toBe(true)
    }
  })
})

/**
 * `pnpm icon` regenerates the icons through `tauri icon` and deletes what no build uses. It used
 * to delete `icon.ico` and the Linux PNGs too, back when the app was macOS-only, so the next
 * Windows or Linux build after running it failed on a missing icon (#14).
 */
describe('icon script', () => {
  it('never deletes an icon a platform config names', () => {
    const script = readFileSync(join(ROOT, 'scripts/render-icon.mts'), 'utf8')
    const list = /for \(const junk of \[([^\]]*)\]\)/.exec(script)
    expect(list, 'the junk list in render-icon.mts moved; update this test').not.toBeNull()
    const deleted = [...(list?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    for (const conf of ['tauri.conf.json', 'tauri.linux.conf.json', 'tauri.windows.conf.json']) {
      const icons = (
        JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src-tauri', conf), 'utf8')) as { bundle: { icon: string[] } }
      ).bundle.icon
      for (const icon of icons) {
        expect(deleted, `${conf} names ${icon}`).not.toContain(icon.replace(/^icons\//, ''))
      }
    }
  })
})

/**
 * ui must not know which OS it is running on (docs/platform-abstraction.md).
 *
 * The point is not tidiness. ui is the one package with no platform implementation
 * behind it, so an OS check there is invisible to every test we run — E2E drives the
 * browser mock, and the mock has no OS. It would only show up as "the Linux build looks
 * wrong" long after the fact. The header padding was the near miss: a hardcoded
 * `pl-[86px]` that is a macOS traffic-light measurement, now asked for through the
 * platform port instead.
 */
describe('ui does not know which OS it is on', () => {
  const FORBIDDEN = [/process\.platform/, /navigator\.platform/, /navigator\.userAgentData/, /\bisMac\b/]
  const src = join(ROOT, 'packages/ui/src')
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f))

  it('has not a single platform branch', () => {
    const offenders = files.filter((f) => {
      const text = readFileSync(join(src, f), 'utf8')
      return FORBIDDEN.some((re) => re.test(text))
    })
    expect(offenders, 'an OS difference belongs in the @cc/platform port or on the Rust side').toEqual([])
  })

  /**
   * Keyboard key names are never written directly onto the screen (issue #32).
   *
   * This is the companion to the ban on OS branching. `⌘` did not look like a branch, so it
   * sailed straight through the check above, and the result was the same — **a screen telling
   * someone to press a key that does not exist.** Worse, it spreads silently: `⌘` is just a
   * character, so writing a new hint by copying the line next to it is all it takes. That is
   * how it reached nineteen spots across ten files.
   *
   * A single sweep is not the end of it. **A repository half-swept is worse than either
   * extreme** — if some spots say `⌘` and others say `Ctrl`, the screen contradicts its own
   * wording. So if it comes back in, this is where it gets caught.
   *
   * Comments are excluded. A `⌘A` inside a comment is a note to whoever reads this code, not
   * something the screen says, and the viewer's copy logic actually documents its reasoning
   * using that exact notation. What this checks is **what gets drawn.** `⇧` is excluded too —
   * it is printed as-is on those same keyboards, so there is no word to translate it to.
   */
  it('keyboard key names come from the port (⌘ and ⌥ are never written directly)', () => {
    // Test files are on the side of **pinning down** the Mac notation, so they are outside
    // this check (packages/ui/src/app/shortcut.test.ts).
    const shipped = files.filter((f) => !/\.test\.tsx?$/.test(f))
    const offenders = shipped.filter((f) => {
      const text = readFileSync(join(src, f), 'utf8')
        // What is left after stripping `/* */` (including the JSX comment `{/* */}`) and `//`
        // lines is what actually goes to the screen.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      return /[⌘⌥]/.test(text)
    })
    expect(offenders, 'use <Kbd mod /> · <Kbd alt /> or useShortcut() instead').toEqual([])
  })
})
