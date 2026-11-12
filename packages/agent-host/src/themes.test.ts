import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THEME_SCHEMA_FILE, themeFileJsonSchema } from '@cc/protocol'
import { ThemeFiles } from './themes.js'
import { eventually, SLOW } from '../../../tooling/test-timing.js'

let root: string
let dir: string
let changes: number
let files: ThemeFiles

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-themes-'))
  dir = join(root, 'themes')
  changes = 0
  files = new ThemeFiles(dir, () => changes++)
  await files.start()
})

afterEach(() => {
  files.close()
  rmSync(root, { recursive: true, force: true })
})

/** Resolves once `changes` has not moved for 300 ms (three settle windows) */
const quiet = async () => {
  for (let seen = -1; seen !== changes; ) {
    seen = changes
    await new Promise((r) => setTimeout(r, 300))
  }
}

/*
 * **Writes until the watcher reports it** (#368). On macOS `fs.watch` runs its FSEvents stream
 * on another thread, and a write made before that stream is running is never reported, not
 * even late. On a loaded machine starting the stream takes long enough to swallow a write made
 * right after `start()`: the test then waited out its whole time limit for an event that was
 * never coming. Writing again until one is heard waits on the watcher itself.
 */
const writeUntilHeard = async (file: string, text: string) => {
  const before = changes
  const until = Date.now() + 10_000 * SLOW
  while (changes === before) {
    if (Date.now() > until) throw new Error('the watcher never reported a write')
    writeFileSync(file, text)
    await eventually(() => changes !== before, 500).catch(() => {})
  }
}

describe('the themes folder (#312)', () => {
  it('creates the folder and writes the schema an editor completes from', () => {
    const schema = JSON.parse(readFileSync(join(dir, THEME_SCHEMA_FILE), 'utf8'))
    expect(schema).toEqual(themeFileJsonSchema())
  })

  it('saves a new theme under an id made from its name, with $schema first, atomically', async () => {
    const saved = await files.save(null, { name: 'Night Owl', base: 'dark', tokens: { 'surface-floor': '#000000' } })
    expect(saved).toMatchObject({ id: 'night-owl', name: 'Night Owl', base: 'dark', tokens: { 'surface-floor': '#000000' }, problems: [], broken: false })
    const text = readFileSync(join(dir, 'night-owl.json'), 'utf8')
    expect(Object.keys(JSON.parse(text))[0]).toBe('$schema')
    // No temp file is left behind
    expect(readdirSync(dir).sort()).toEqual(['night-owl.json', THEME_SCHEMA_FILE])
    // The same name again gets its own file rather than overwriting
    expect((await files.save(null, { name: 'Night Owl', base: 'light', tokens: {} })).id).toBe('night-owl-2')
  })

  // #2214: a file under a preset's id shadows the preset in the window, so a new theme never takes one
  it('never files a new theme under a preset id: a theme named like a preset keeps its name and gets a number, and a file already under one still works', async () => {
    const graphite = await files.save(null, { name: 'Graphite', base: 'dark', tokens: {} })
    expect(graphite).toMatchObject({ id: 'graphite-2', name: 'Graphite' })
    expect((await files.save(null, { name: 'Dark', base: 'dark', tokens: {} })).id).toBe('dark-2')
    expect((await files.save(null, { name: 'High contrast light', base: 'light', tokens: {} })).id).toBe('high-contrast-light')
    expect((await files.save(null, { name: 'hc-dark', base: 'dark', tokens: {} })).id).toBe('hc-dark-2')
    expect(readdirSync(dir)).not.toContain('graphite.json')
    // A file stored under a preset id before this rule keeps working as the custom theme it is, and is saved in place
    writeFileSync(join(dir, 'light.json'), JSON.stringify({ name: 'My light', base: 'light', tokens: { 'surface-floor': '#101820' } }))
    expect(await files.list()).toContainEqual(expect.objectContaining({ id: 'light', name: 'My light', broken: false, tokens: { 'surface-floor': '#101820' } }))
    expect(await files.save('light', { name: 'My light', base: 'light', tokens: { 'surface-floor': '#112233' } })).toMatchObject({ id: 'light', tokens: { 'surface-floor': '#112233' } })
    expect(readdirSync(dir).filter((n) => n.startsWith('light'))).toEqual(['light.json'])
  })

  it('refuses an explicit id that is a preset id unless a file is stored under it already (#2214)', async () => {
    await expect(files.save('graphite', { name: 'Mine', base: 'dark', tokens: {} })).rejects.toThrow("graphite is a preset's id")
    expect(readdirSync(dir)).not.toContain('graphite.json')
  })

  it('a file imported under a preset name gets its own id too', async () => {
    const source = join(root, 'Light.json')
    writeFileSync(source, JSON.stringify({ name: 'Light', base: 'light', tokens: { 'surface-floor': '#fafafa' } }))
    expect((await files.importFrom(source)).id).toBe('light-2')
  })

  it('lists a file that does not read, with the reason, instead of dropping it', async () => {
    writeFileSync(join(dir, 'half.json'), '{ "name": "Half", "base": ')
    const [entry] = await files.list()
    expect(entry).toMatchObject({ id: 'half', broken: true })
    expect(entry!.problems[0]).toMatch(/^Not valid JSON/)
  })

  it('reports unknown keys and tokens, and keeps the rest', async () => {
    writeFileSync(
      join(dir, 'odd.json'),
      JSON.stringify({ name: 'Odd', base: 'light', colour: 'x', tokens: { ink: '#111', glitter: '#fff', 'ink-faint': 3 } }),
    )
    const [entry] = await files.list()
    expect(entry).toMatchObject({ name: 'Odd', base: 'light', tokens: { ink: '#111' }, broken: false })
    expect(entry!.problems).toEqual([
      'Unknown key "colour" is ignored.',
      'Unknown token "glitter" is ignored.',
      'Token "ink-faint" needs a CSS value as a string.',
    ])
  })

  // The activity tokens left with the session orbit (#736): a file that still sets them did nothing wrong (#844), so they are skipped without a problem
  it('skips the retired activity tokens without a problem and keeps the rest', async () => {
    writeFileSync(
      join(dir, 'old.json'),
      JSON.stringify({ name: 'Old', base: 'dark', tokens: { ink: '#111', 'activity-1': '#2d6cf0', 'activity-5': '#4ad6d0' } }),
    )
    const [entry] = await files.list()
    expect(entry).toMatchObject({ name: 'Old', tokens: { ink: '#111' }, broken: false })
    expect(entry!.problems).toEqual([])
  })

  it('announces a hand edit, once per burst of writes', async () => {
    const file = join(dir, 'mine.json')
    await writeUntilHeard(file, JSON.stringify({ name: 'Mine', base: 'dark', tokens: {} }))
    await quiet()
    // The watcher is live now: a burst of writes is announced once
    const before = changes
    for (const base of ['light', 'dark', 'light']) writeFileSync(file, JSON.stringify({ name: 'Mine', base, tokens: {} }))
    // 10 s, not 3: a file-system event can arrive seconds late on a loaded machine. The full
    // suite timed out at 3 s on 2026-10-05 while the same test passed alone every time.
    await eventually(() => changes > before, 10_000)
    await quiet()
    expect(changes).toBe(before + 1)
  }, 30_000 * SLOW)

  it('imports a file from elsewhere as it is, and refuses one that is not a theme', async () => {
    const outside = join(root, 'Shared Theme.json')
    writeFileSync(outside, JSON.stringify({ name: 'Shared', base: 'dark', tokens: { ink: '#eee' } }))
    const imported = await files.importFrom(outside)
    expect(imported).toMatchObject({ id: 'shared', tokens: { ink: '#eee' } })
    writeFileSync(join(root, 'bad.json'), 'nope')
    await expect(files.importFrom(join(root, 'bad.json'))).rejects.toThrow(/Not valid JSON/)
  })

  it('refuses a path that is not an id, so trash and reveal cannot leave the folder', () => {
    expect(() => files.pathOf('../prefs')).toThrow(/Not a theme id/)
    expect(files.pathOf('ok-1')).toBe(join(dir, 'ok-1.json'))
  })
})

describe('writing and removing (#1981)', () => {
  it('refuses a theme bigger than the reader accepts, and writes nothing', async () => {
    const tokens = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['t' + i, 'x'.repeat(390)]))
    await expect(files.save(null, { name: 'Huge', base: 'dark', tokens })).rejects.toThrow(/too large/)
    expect(readdirSync(dir).filter((n) => n.endsWith('.json') && n !== THEME_SCHEMA_FILE)).toEqual([])
  })

  it('does not overwrite a hand-written file the list does not show because of its capital letters', async () => {
    writeFileSync(join(dir, 'Paper.json'), '{"name":"Mine","base":"light"}')
    await expect(files.save('paper', { name: 'Paper', base: 'light', tokens: {} })).rejects.toThrow(/Paper\.json/)
    expect(readFileSync(join(dir, 'Paper.json'), 'utf8')).toContain('Mine')
  })

  it('moves a removed file to a place of its own each time, and says where', async () => {
    await files.save('a', { name: 'A', base: 'dark', tokens: {} })
    const first = await files.remove('a')
    await files.save('a', { name: 'A', base: 'dark', tokens: {} })
    const second = await files.remove('a')
    expect(first).not.toBe(second)
    expect(readdirSync(join(dir, '.removed'))).toHaveLength(2)
    expect(await files.remove('a')).toBeNull()
    expect(await files.list()).toEqual([])
  })
})
