import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store } from '../dev-services/store.js'
import { storeMirror, storeProjectOrder, storeRegistry } from './stored.js'

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

  it('keeps a grid panel of a remote app while its machine and project are known, apart from this host’s app of one id, and drops it with the machine', () => {
    const store = new Store()
    storeRegistry(store).add(machine('a'))
    storeMirror(store).replace('a', 'projects', [{ id: 'p1' }])
    const elsewhere = (p: { projectId: string | null; machine?: string }) => (p.projectId?.startsWith('a.') ? 'a' : (p.machine ?? null))
    store.setGridView(
      [
        { kind: 'app', projectId: null, appId: 'notes' },
        { kind: 'app', projectId: null, appId: 'notes', machine: 'a', span: { cols: 2, rows: 1 } },
        { kind: 'app', projectId: 'a.p1', appId: 'board' },
        { kind: 'app', projectId: 'a.gone', appId: 'board' },
      ],
      () => false,
      elsewhere,
    )
    // a.gone's project is not known to the mirror: not listed
    expect(store.listGridView()).toEqual([
      { kind: 'app', projectId: null, appId: 'notes' },
      { kind: 'app', projectId: null, appId: 'notes', machine: 'a', span: { cols: 2, rows: 1 } },
      { kind: 'app', projectId: 'a.p1', appId: 'board' },
    ])
    storeRegistry(store).remove('a')
    expect(store.listGridView()).toEqual([{ kind: 'app', projectId: null, appId: 'notes' }])
  })

  it('v47 only adds: a host before it reads only its own apps from the grid, never a machine’s app of the same id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v47-'))
    try {
      const db = join(dir, 'store.db')
      const store = new Store(db)
      storeRegistry(store).add(machine('a'))
      store.setGridView(
        [
          { kind: 'app', projectId: null, appId: 'notes', machine: 'a' },
          { kind: 'app', projectId: null, appId: 'timer' },
        ],
        () => false,
        (p) => p.machine ?? null,
      )
      store.close()
      // What a v46 host runs to read the grid's apps (store.ts before #82 phase 2)
      const raw = new Database(db)
      const rows = raw
        .prepare(
          `SELECT g.project_id, g.app_id FROM grid_layout g
             LEFT JOIN projects p ON g.kind = 'app' AND p.id = g.project_id
            WHERE (g.kind = 'app' AND g.app_id IS NOT NULL AND (g.project_id IS NULL OR p.id IS NOT NULL))`,
        )
        .all()
      expect(rows).toEqual([{ project_id: null, app_id: 'timer' }])
      raw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

describe('the project order across machines in the store (#734)', () => {
  it('reads back what was written; nothing written, or a value it cannot read, is no order', () => {
    const store = new Store()
    const order = storeProjectOrder(store)
    expect(order.read()).toEqual([])
    order.write(['m1.b', 'h2', 'm1.a'])
    expect(storeProjectOrder(store).read()).toEqual(['m1.b', 'h2', 'm1.a'])
    store.setAppSetting('hub.projectOrder', '{oops')
    expect(order.read()).toEqual([])
  })
})
