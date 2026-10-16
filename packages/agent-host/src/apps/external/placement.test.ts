import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps } from './runtime.js'

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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-place-')))
  dataRoot = join(root, 'data')
  outside = join(root, 'outside')
  mkdirSync(dataRoot)
  mkdirSync(outside)
  rt = new ExternalApps({ projects: () => [], dataRoot, reservedIds: [] })
  rt.refresh()
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
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
