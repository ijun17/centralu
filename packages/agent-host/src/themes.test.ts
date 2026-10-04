import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THEME_SCHEMA_FILE, themeFileJsonSchema } from '@cc/protocol'
import { ThemeFiles } from './themes.js'

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

// 10 s, not 3: a file-system event can arrive seconds late on a loaded machine. The full
// suite timed out at 3 s on 2026-10-05 while the same test passed alone every time.
const waitFor = async (check: () => boolean, ms = 10_000) => {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
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

  it('announces a hand edit, once per burst of writes', async () => {
    writeFileSync(join(dir, 'mine.json'), JSON.stringify({ name: 'Mine', base: 'dark', tokens: {} }))
    await waitFor(() => changes > 0)
    const after = changes
    await new Promise((r) => setTimeout(r, 300))
    expect(changes).toBe(after)
  })

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
