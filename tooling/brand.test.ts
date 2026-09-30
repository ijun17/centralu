import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { APP_ID, APP_NAME, APP_SLUG, APP_VERSION } from '../packages/protocol/src/brand.js'

/** The marker put on a line that deliberately knows the old name — this file skips that line. */
const LEGACY_MARK = 'legacy-name'

/**
 * The naming contract.
 *
 * The app name is baked into places TypeScript cannot reach — `index.html`,
 * `tauri.conf.json`, `Cargo.toml`, launch scripts. **The build still passes even if those
 * drift out of sync.** The only way to notice is to open the built app. So instead of
 * binding it into a constant, this checks it here: screen text stays a readable literal, and
 * if a static file disagrees with `brand.ts`, this test fails and names the file.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>

describe('the name is decided in one place', () => {
  it('the window title and bundle name match APP_NAME', () => {
    const tauri = json('apps/desktop/src-tauri/tauri.conf.json')
    expect(tauri.productName).toBe(APP_NAME)
    expect((tauri.app as { windows: { title: string }[] }).windows[0]?.title).toBe(APP_NAME)
  })

  it('the bundle identifier matches APP_ID', () => {
    expect(json('apps/desktop/src-tauri/tauri.conf.json').identifier).toBe(APP_ID)
  })

  it('both browser tab titles match APP_NAME', () => {
    for (const p of ['apps/desktop/index.html', 'apps/web/index.html']) {
      expect(read(p), p).toContain(`<title>${APP_NAME}</title>`)
    }
  })

  it('the version matches in all three places', () => {
    expect(json('apps/desktop/src-tauri/tauri.conf.json').version).toBe(APP_VERSION)
    expect(json('apps/desktop/package.json').version).toBe(APP_VERSION)
    expect(read('apps/desktop/src-tauri/Cargo.toml')).toContain(`version = "${APP_VERSION}"`)
  })

  it('the npm package name and version follow brand.ts', () => {
    // Publishing cannot be undone (npm blocks unpublish after 24 hours). This catches a
    // mismatch here first, before it can go out — the release script writes the same values
    // back too.
    const main = json('packaging/npm/centralu/package.json')
    expect(main.name).toBe(APP_SLUG)
    expect(main.version).toBe(APP_VERSION)

    /*
     * One entry per platform package. The bundle name is what the launcher looks for by
     * literal name, so a rename that reaches `files` but not the launcher (or the reverse)
     * ships a package that installs and then cannot find its own app.
     */
    const platforms = [
      { dir: 'darwin-arm64', bundle: `${APP_NAME}.app` },
      { dir: 'linux-arm64', bundle: `${APP_NAME}.AppImage` },
      { dir: 'linux-x64', bundle: `${APP_NAME}.AppImage` },
    ]
    for (const { dir, bundle } of platforms) {
      const arch = json(`packaging/npm/${dir}/package.json`)
      expect(arch.name, dir).toBe(`${APP_SLUG}-${dir}`)
      expect(arch.version, dir).toBe(APP_VERSION)
      // The shell and the contents have to be **exactly the same version** (left as a range,
      // they could drift apart).
      expect((main.optionalDependencies as Record<string, string>)[arch.name as string], dir).toBe(APP_VERSION)
      // The bundle name carried by the architecture package also follows APP_NAME.
      expect(arch.files, dir).toContain(bundle)
    }

    /*
     * npm refuses to install a package whose `os` does not list the running platform. Miss
     * one here and the shim is simply uninstallable on that platform — with an npm error
     * about the shim, which points nowhere near this file.
     */
    expect(main.os).toEqual(expect.arrayContaining(['darwin', 'linux']))
    expect(Object.keys(main.optionalDependencies as object).sort()).toEqual(
      platforms.map((p) => `${APP_SLUG}-${p.dir}`).sort(),
    )
  })

  it('the two Linux architectures never receive each other\'s package (#29)', () => {
    /*
     * npm picks between these two on `cpu` alone — they share `os`, a version, and a
     * bundle name. Get one `cpu` wrong and the mistake does not show up here or at
     * install time; it shows up as an AppImage that will not start on someone's machine,
     * which is the one failure nobody on this project can reproduce.
     */
    for (const [dir, cpu] of [
      ['linux-arm64', 'arm64'],
      ['linux-x64', 'x64'],
    ] as const) {
      const arch = json(`packaging/npm/${dir}/package.json`)
      expect(arch.os, dir).toEqual(['linux'])
      expect(arch.cpu, dir).toEqual([cpu])
    }
  })

  it('the script that opens the built .app points at the real bundle name', () => {
    // A changed productName also changes the bundle file name — a script left on the old path
    // just quietly fails to open it.
    const scripts = json('package.json').scripts as Record<string, string>
    for (const [name, cmd] of Object.entries(scripts)) {
      if (cmd.includes('bundle/macos/')) expect(cmd, name).toContain(`bundle/macos/${APP_NAME}.app`)
    }
  })

  it('the old name is not left anywhere', () => {
    /*
     * The most common failure in a rename is "missing a few spots", and the spots that get
     * missed tend to sit for a long time in places nobody looks, like comments and test
     * titles. This looks at every tracked file at once.
     *
     * The data folder (`.control-center`) is the exception — renaming it would make the
     * person's entire conversation history disappear, so the old name is kept there **on
     * purpose** (see DATA_DIR in brand.ts).
     */
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n')
    const offenders: string[] = []
    for (const f of files) {
      if (f === 'tooling/brand.test.ts') continue
      let text: string
      try {
        text = read(f)
      } catch {
        continue // binary or symlink
      }
      const stale = text
        .split('\n')
        .map((line, i) => ({ line, i: i + 1 }))
        .filter(({ line }) => /control[ _-]?center/i.test(line))
        /*
         * Exceptions are **not grown into a list.**
         *
         * The data folder, a DB table and the repository folder used to be written here as
         * exceptions. A list like that only ever grows, and a grown list eventually makes a
         * check that "looks for the old name" toothless. So both of those were removed by
         * migration instead (the folder by rename, the table by ALTER TABLE), and what
         * remains — code that has to know the old name **in order to carry out** the rename
         * — has the `legacy-name` marker put on that line. The exception is written at the
         * site, not in the test.
         */
        .filter(({ line }) => !line.includes(LEGACY_MARK))
        // The repository folder name is the person's own local directory (it appears as a
        // path in the documentation's structure diagram).
        .filter(({ line }) => line.trim() !== 'control-center/')
      if (stale.length > 0) offenders.push(`${f}:${stale.map((s) => s.i).join(',')}`)
    }
    expect(offenders).toEqual([])
  })
})
