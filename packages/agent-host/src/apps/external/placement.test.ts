import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppFolderTaken, appFolderTaken, nameTaken, placeAppFolder } from './placement.js'
import { ExternalApps } from './runtime.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * Where an app folder is placed (`placement.ts`) — every door that writes a new app folder goes
 * through the path guard, so a linked `apps/` that points out of the data folder writes nothing
 * there. Checked through the runtime's own doors, on a real folder tree.
 */

let root = ''
let dataRoot = ''
let outside = ''
let rt: ExternalApps

beforeEach(() => {
  root = tempRoot('cc-app-place-')
  dataRoot = join(root, 'data')
  outside = join(root, 'outside')
  mkdirSync(dataRoot)
  mkdirSync(outside)
  rt = new ExternalApps({ projects: () => [], dataRoot, reservedIds: [] })
  rt.refresh()
})

afterEach(async () => {
  await rt.dispose()
  await removeTree(root)
})

const server = { command: process.execPath, args: ['server.mjs'] }

describe('a new user-folder app is placed through the path guard', () => {
  it('an approved MCP server is refused when the data folder\'s apps/ is a link pointing outside it — nothing is written there', () => {
    symlinkSync(outside, join(dataRoot, 'apps'))
    expect(() => rt.installUserApp({ id: 'db', name: 'db', description: 'a server', server })).toThrow(/Could not write the app folder/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('a new app from the template is refused the same way', () => {
    symlinkSync(outside, join(dataRoot, 'apps'))
    expect(() => rt.createApp({ projectId: null, id: 'notes', name: 'Notes' })).toThrow(/Could not make the app folder/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('an approved MCP server gets its folder and its data folder, and is discovered at once', () => {
    const made = rt.installUserApp({ id: 'db', name: 'db', description: 'a server', server })
    expect(made).toMatchObject({ appId: 'db', projectId: null, status: 'stopped', dir: join(dataRoot, 'apps', 'db') })
    expect(existsSync(join(dataRoot, 'app-data', '_user', 'db'))).toBe(true)
    // No temp folder is left beside it
    expect(readdirSync(join(dataRoot, 'apps'))).toEqual(['db'])
  })
})

/*
 * A name that is taken stays what it is (#1143). Every door asks `placeAppFolder`, which refuses a name with anything on it,
 * a broken link included (lstat): a check by `existsSync` follows the link, finds nothing, and the new folder is renamed
 * over a name someone put there.
 */
describe('a new app is never placed over a name that is taken', () => {
  const dangling = () => {
    mkdirSync(join(dataRoot, 'apps'))
    symlinkSync(join(root, 'gone'), join(dataRoot, 'apps', 'db'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(existsSync(join(dataRoot, 'apps', 'db'))).toBe(false)
    expect(nameTaken(join(dataRoot, 'apps', 'db'))).toBe(true)
  }

  it('an approved MCP server is refused over a broken link of its id, and the link stays', () => {
    dangling()
    expect(() => rt.installUserApp({ id: 'db', name: 'db', description: 'a server', server })).toThrow('Your user folder already has an app "db"')
    expect(nameTaken(join(dataRoot, 'apps', 'db'))).toBe(true)
    expect(readdirSync(join(dataRoot, 'apps'))).toEqual(['db'])
  })

  it('a new app from the template is refused the same way, naming the place', () => {
    dangling()
    expect(() => rt.createApp({ projectId: null, id: 'db', name: 'Db' })).toThrow(`An app "db" already exists (${join(dataRoot, 'apps', 'db')})`)
    expect(readdirSync(join(dataRoot, 'apps'))).toEqual(['db'])
  })

  it('a folder with no manifest at the id is someone’s too, for both doors', () => {
    mkdirSync(join(dataRoot, 'apps', 'db'), { recursive: true })
    expect(() => rt.installUserApp({ id: 'db', name: 'db', description: 'a server', server })).toThrow('already has an app "db"')
    expect(() => rt.createApp({ projectId: null, id: 'db', name: 'Db' })).toThrow('already exists')
    expect(readdirSync(join(dataRoot, 'apps', 'db'))).toEqual([])
  })

  it('a name that appears while the folder is being written is not replaced, and no temp folder is left', () => {
    const dir = join(dataRoot, 'apps', 'late')
    expect(() =>
      placeAppFolder(dataRoot, null, 'late', (staging) => {
        mkdirSync(staging)
        // Someone made the folder meanwhile: an empty one, which a rename would replace without a word
        mkdirSync(dir)
      }),
    ).toThrow(new AppFolderTaken(dir))
    expect(readdirSync(join(dataRoot, 'apps'))).toEqual(['late'])
    expect(readdirSync(dir)).toEqual([])
  })

  it('a free name is placed, and says where', () => {
    const dir = placeAppFolder(dataRoot, null, 'free', (staging) => mkdirSync(staging))
    expect(dir).toBe(join(dataRoot, 'apps', 'free'))
    expect(appFolderTaken(dataRoot, null, 'free')).toBe(true)
    expect(appFolderTaken(dataRoot, null, 'other')).toBe(false)
  })
})
