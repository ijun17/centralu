import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store } from '../dev-services/store.js'
import type { SshTunnel } from './tunnel.js'
import { hubSelfId, linkDepsFor, storeMirror, storeProjectOrder, storeRegistry, tunnelsFor } from './stored.js'

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
    store.grid.setGridView(
      [
        { kind: 'session', sessionId: 'a.s1' },
        { kind: 'session', sessionId: 'a.gone' },
      ],
      () => true,
    )
    // a.gone is stored but not known to the mirror: not listed
    expect(store.grid.listGridView()).toEqual([{ kind: 'session', sessionId: 'a.s1' }])
    storeRegistry(store).remove('a')
    expect(store.grid.listGridView()).toEqual([])
  })

  it('keeps a grid panel of a remote app while its machine and project are known, apart from this host’s app of one id, and drops it with the machine', () => {
    const store = new Store()
    storeRegistry(store).add(machine('a'))
    storeMirror(store).replace('a', 'projects', [{ id: 'p1' }])
    const elsewhere = (p: { projectId: string | null; machine?: string }) => (p.projectId?.startsWith('a.') ? 'a' : (p.machine ?? null))
    store.grid.setGridView(
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
    expect(store.grid.listGridView()).toEqual([
      { kind: 'app', projectId: null, appId: 'notes' },
      { kind: 'app', projectId: null, appId: 'notes', machine: 'a', span: { cols: 2, rows: 1 } },
      { kind: 'app', projectId: 'a.p1', appId: 'board' },
    ])
    storeRegistry(store).remove('a')
    expect(store.grid.listGridView()).toEqual([{ kind: 'app', projectId: null, appId: 'notes' }])
  })

  it('v47 only adds: a host before it reads only its own apps from the grid, never a machine’s app of the same id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v47-'))
    try {
      const db = join(dir, 'store.db')
      const store = new Store(db)
      storeRegistry(store).add(machine('a'))
      store.grid.setGridView(
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
      store.grid.setGridView([{ kind: 'session', sessionId: 'a.s1' }], () => true)
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
    store.settings.setAppSetting('hub.projectOrder', '{oops')
    expect(order.read()).toEqual([])
  })
})

describe('this host’s id (#550, and the host id in every mail address)', () => {
  it('two hosts on one store that both find none at first end up with the one that was written first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-hub-self-'))
    const file = join(dir, 'store.db')
    const a = new Store(file)
    const b = new Store(file)
    try {
      // `a` has read "none" when `b` makes and keeps its id; `a` then makes its own
      const read = a.settings.appSetting.bind(a.settings)
      let first = true
      a.settings.appSetting = (key: string) => {
        if (first) {
          first = false
          return null
        }
        return read(key)
      }
      const winner = hubSelfId(b)
      const loser = hubSelfId(a)
      expect(loser).toBe(winner)
      expect(hubSelfId(b)).toBe(winner)
    } finally {
      a.close()
      b.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /*
   * #1405 review: the label a hub pairs as ends in its own key, drawn from this id. A key from the data folder's path
   * gave two hubs of one computer name and one path a single label, each replacing the other's credential at each link
   */
  it('is what the tunnel a link opens pairs under: two stores at one path pair as two hubs', () => {
    const record = { id: 'm1', name: 'box', sshTarget: 'box', remote: { shell: 'posix' as const }, slot: 1, addedAt: 0, acceptedVersions: null }
    const labels = [new Store(), new Store()].map((store) => {
      try {
        const label = tunnelsFor(store, () => {})(record).pairsAs
        expect(label.endsWith(`-${hubSelfId(store).slice('hub-'.length)}`)).toBe(true)
        return label
      } finally {
        store.close()
      }
    })
    expect(labels[0]).not.toBe(labels[1])
  })

  /*
   * #1405 review: main.ts gives `new Links` the deps `linkDepsFor` makes, and cannot name a tunnel of its own (the type
   * leaves it out). Driven through that function with a real store, the label a link pairs under is the store's id
   */
  it("makes the tunnel main.ts links with from the store: it pairs as the store's hub id, and main.ts has no tunnel of its own to give", () => {
    const record = { id: 'm1', name: 'box', sshTarget: 'box', remote: { shell: 'posix' as const }, slot: 1, addedAt: 0, acceptedVersions: null }
    const rest = { hub: { version: '0', protocolVersion: 1, dev: true }, broadcast: () => {}, terminal: () => {}, installer: {} as never, hubSelf: () => ({ id: 'x', name: 'x' }) }
    const store = new Store()
    try {
      const deps = linkDepsFor(store, rest)
      expect((deps.tunnelFor(record) as SshTunnel).pairsAs.endsWith(`-${hubSelfId(store).slice('hub-'.length)}`)).toBe(true)
      // The registry is the store's too
      deps.registry.add({ id: 'm1', name: 'box', sshTarget: 'box', remote: { shell: 'posix' as const }, addedAt: 0, acceptedVersions: null })
      expect(storeRegistry(store).list().map((m) => m.id)).toEqual(['m1'])
      // Even handed one past the type, the store's is what is made
      const own = linkDepsFor(store, { ...rest, tunnelFor: () => { throw new Error('not taken') } } as never)
      expect((own.tunnelFor(record) as SshTunnel).pairsAs).toBe((deps.tunnelFor(record) as SshTunnel).pairsAs)
    } finally {
      store.close()
    }
  })
})
