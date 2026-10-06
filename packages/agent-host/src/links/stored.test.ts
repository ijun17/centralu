import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store } from '../dev-services/store.js'
import { storeMirror, storeRegistry } from './stored.js'

/** The linked machines and the headers mirror in the hub's store (#82, store v46) */

const machine = (id: string) => ({ id, name: id, sshTarget: `${id}.lan`, remote: { shell: 'wsl' as const, wslDistro: 'Ubuntu-24.04', command: null }, addedAt: 1, acceptedVersions: null })

describe('linked machines in the store (#82)', () => {
  it('keeps a machine with its remote shell, and never hands a slot out twice', () => {
    const store = new Store()
    const reg = storeRegistry(store)
    expect(reg.add(machine('a')).slot).toBe(1)
    expect(reg.add(machine('b')).slot).toBe(2)
    reg.remove('b')
    // b's folded rule ids may still be on a screen: the next machine does not inherit its slot
    expect(reg.add(machine('c')).slot).toBe(3)
    expect(reg.list()).toEqual([
      expect.objectContaining({ id: 'a', slot: 1, remote: { shell: 'wsl', wslDistro: 'Ubuntu-24.04', command: null } }),
      expect.objectContaining({ id: 'c', slot: 3 }),
    ])
    reg.setAcceptedVersions('a', '1|2')
    expect(reg.list()[0]!.acceptedVersions).toBe('1|2')
  })

  it('mirrors headers per machine: never read is null, read empty is empty, and a removed machine leaves nothing', () => {
    const store = new Store()
    const reg = storeRegistry(store)
    const mirror = storeMirror(store)
    reg.add(machine('a'))
    expect(mirror.read('a', 'sessions')).toBeNull()
    mirror.replace('a', 'sessions', [])
    expect(mirror.read('a', 'sessions')).toEqual([])
    mirror.replace('a', 'sessions', [{ id: 's2', name: 'two', state: 'idle' }, { id: 's1', name: 'one', state: 'idle' }])
    mirror.patchSession('a', 's1', { state: 'working', name: 'uno' })
    mirror.upsertSession('a', { id: 's3', name: 'three' })
    mirror.removeSession('a', 's2')
    // The order the remote listed them in, a new one last
    expect(mirror.read('a', 'sessions')).toEqual([{ id: 's1', name: 'uno', state: 'working' }, { id: 's3', name: 'three' }])
    reg.remove('a')
    expect(mirror.read('a', 'sessions')).toBeNull()
    // A machine that is not linked gets no headers at all
    mirror.replace('ghost', 'projects', [{ id: 'p' }])
    expect(mirror.read('ghost', 'projects')).toBeNull()
  })

  it('keeps a grid panel of a remote session while the mirror knows it, and drops it with the machine', () => {
    const store = new Store()
    storeRegistry(store).add(machine('a'))
    storeMirror(store).replace('a', 'sessions', [{ id: 's1' }])
    store.setGridView(
      [
        { kind: 'session', sessionId: 'a.s1' },
        { kind: 'session', sessionId: 'a.gone' },
      ],
      () => true,
    )
    // a.gone is stored but not known to the mirror: not listed
    expect(store.listGridView()).toEqual([{ kind: 'session', sessionId: 'a.s1' }])
    storeRegistry(store).remove('a')
    expect(store.listGridView()).toEqual([])
  })

  it('v46 only adds: a store built by it still reads its grid through the old query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v46-'))
    try {
      const db = join(dir, 'store.db')
      const store = new Store(db)
      storeRegistry(store).add(machine('a'))
      storeMirror(store).replace('a', 'sessions', [{ id: 's1' }])
      store.setGridView([{ kind: 'session', sessionId: 'a.s1' }], () => true)
      store.close()
      // What a v45 host runs to read the grid (store.ts before #82): the remote panel is left out, nothing fails
      const raw = new Database(db)
      const rows = raw
        .prepare(
          `SELECT g.kind, g.session_id FROM grid_layout g
             LEFT JOIN sessions s ON g.kind = 'session' AND s.id = g.session_id
            WHERE (g.kind = 'session' AND s.id IS NOT NULL AND s.deleted_at IS NULL)`,
        )
        .all()
      expect(rows).toEqual([])
      expect(raw.prepare(`SELECT value FROM app_settings WHERE key = 'min_reader_version'`).get()).toEqual({ value: expect.not.stringMatching(/^46$/) })
      raw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
