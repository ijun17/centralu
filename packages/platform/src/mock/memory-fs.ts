import { wireBaseName, wireJoin, wireSegments } from '@cc/protocol'
import type { FsEntry, FsFile } from '../ports/index.js'

/** The mock's file tree: the listing grouped by parent path, and the file contents by path */
export type MemoryFsState = { entries: Record<string, FsEntry[]>; files: Record<string, string> }

/**
 * The mock's in-memory file system, behind MockPlatform's `fs` port.
 *
 * It owns the tree and the host's rules for changing it. What the port also records for tests
 * (reads, watches, trashed and revealed paths) stays on MockPlatform.
 */
export class MemoryFs {
  state: MemoryFsState = { entries: {}, files: {} }

  /**
   * A path that goes outside the root gets rejected **in the mock too**.
   *
   * This is a spot it would have been tempting to skip, on the theory that a mock with no real
   * filesystem needs no check either. Then "cannot touch outside the project" would become a
   * rule that exists only in the real thing, and the difference would be invisible to e2e (the
   * browser's mock) forever — the contract test actually caught this having split here.
   * Decidable from the string alone: count segments, and going outside is whatever makes the
   * depth negative after stepping down through a `..`.
   *
   * The segments come from `wireSegments` rather than from a `/` written here (#47). Reading the
   * separator out of the protocol instead of assuming it is what makes this check the *same*
   * check the host runs: both sides now name one encoding, so a path that means two things on
   * two machines cannot mean the right thing here and the wrong thing there.
   */
  requireInside(rel: string): void {
    const fail = () => {
      throw Object.assign(new Error('Path is outside the project'), { code: 'internal' })
    }
    if (rel.startsWith('/')) fail()
    let depth = 0
    for (const seg of wireSegments(rel)) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') depth -= 1
      else depth += 1
      if (depth < 0) fail()
    }
  }

  /** `a/b/c.ts` → `a/b` (the root is `''`) — since the mock's entries are grouped by parent path */
  private parentOf(path: string): string {
    const cut = path.lastIndexOf('/')
    return cut < 0 ? '' : path.slice(0, cut)
  }

  /**
   * Detaches one entry from the mock. If it is a folder, everything under it — the listing and
   * the files — comes along. In the real thing, moving a folder takes what is inside it along
   * too, so if the mock moved only the shell, "it moved, but the inside is empty" would become
   * a kind of difference that happens **only in the mock**.
   */
  private detach(path: string): FsEntry | null {
    const parent = this.parentOf(path)
    const siblings = this.state.entries[parent] ?? []
    const entry = siblings.find((e) => e.path === path)
    if (!entry) return null
    this.state.entries[parent] = siblings.filter((e) => e.path !== path)
    return entry
  }

  /** What comes along when moving or deleting — the sub-listing and file contents */
  private takeSubtree(path: string): MemoryFsState {
    const under = (p: string) => p === path || p.startsWith(`${path}/`)
    const entries: Record<string, FsEntry[]> = {}
    const files: Record<string, string> = {}
    for (const [dir, list] of Object.entries(this.state.entries)) {
      if (!under(dir)) continue
      entries[dir] = list
      delete this.state.entries[dir]
    }
    for (const [file, text] of Object.entries(this.state.files)) {
      if (!under(file)) continue
      files[file] = text
      delete this.state.files[file]
    }
    return { entries, files }
  }

  /**
   * Lays one file down in the mock and builds **the whole path up to it** (#104).
   *
   * In the real thing, the host creates the parent folders before writing. If the mock only
   * planted the content, that file would be readable but `trash` would fail to find it in the
   * listing and reject it — a spot where the mock becomes stricter than the real thing, and
   * handoff cleanup would fail only in the mock. When a test needs to fake "the agent left a
   * note," it should also come in through this door, so nobody has to rediscover that trap on
   * their own.
   */
  place(path: string, text: string): void {
    this.state.files[path] = text
    const segs = wireSegments(path).filter(Boolean)
    for (let i = 0; i < segs.length; i++) {
      const here = wireJoin(...segs.slice(0, i + 1))
      const parent = wireJoin(...segs.slice(0, i))
      const list = this.state.entries[parent] ?? []
      if (list.some((e) => e.path === here)) continue
      this.state.entries[parent] = [
        ...list,
        { name: segs[i]!, path: here, isDir: i < segs.length - 1, ignored: false },
      ]
    }
  }

  search(query: string, limit: number): { path: string; name: string }[] {
    // The mock does not fake real fuzzy matching — what is being verified is the UI flow
    const all = Object.values(this.state.entries)
      .flat()
      .filter((e) => !e.isDir)
    const q = query.toLowerCase()
    return all
      .filter((e) => e.path.toLowerCase().includes(q))
      .slice(0, limit)
      .map((e) => ({ path: e.path, name: e.name }))
  }

  listDir(path: string): FsEntry[] {
    return this.state.entries[path] ?? []
  }

  readFile(path: string): FsFile {
    return {
      text: this.state.files[path] ?? '',
      truncated: false,
      binary: false,
      bytes: (this.state.files[path] ?? '').length,
    }
  }

  resolve(path: string): { path: string } {
    this.requireInside(path)
    return { path: `/mock-project/${path}` }
  }

  /**
   * Follows **the same rejection rules** as the real thing (the host's `moveEntry`): if the
   * spot is taken, it does not move and names what it collided with; a folder cannot be put
   * inside itself; and dropping something back where it already was is `moved: false`, not a
   * failure. If the mock were more forgiving than the real thing, e2e would stay green while
   * the actual app behaved differently.
   */
  move(from: string, toDir: string): { path: string; moved: boolean } {
    this.requireInside(from)
    this.requireInside(toDir)
    const name = wireBaseName(from)
    const path = wireJoin(toDir, name)
    if (path === from) return { path, moved: false }
    if (path.startsWith(`${from}/`)) {
      throw Object.assign(new Error(`Cannot move ${name} into itself`), { code: 'internal' })
    }
    if ((this.state.entries[toDir] ?? []).some((e) => e.path === path)) {
      throw Object.assign(new Error(`${path} already exists — nothing was moved`), { code: 'internal' })
    }
    const entry = this.detach(from)
    if (!entry) throw Object.assign(new Error(`${from} is no longer there`), { code: 'internal' })
    const sub = this.takeSubtree(from)
    const rekey = (p: string) => path + p.slice(from.length)
    for (const [dir, list] of Object.entries(sub.entries)) {
      this.state.entries[rekey(dir)] = list.map((e) => ({ ...e, path: rekey(e.path) }))
    }
    for (const [file, text] of Object.entries(sub.files)) this.state.files[rekey(file)] = text
    this.state.entries[toDir] = [...(this.state.entries[toDir] ?? []), { ...entry, path }]
    return { path, moved: true }
  }

  importFile(toDir: string, name: string, dataBase64: string): { path: string } {
    this.requireInside(toDir)
    // Uses only the last segment of the name — the same rule as the real thing, so even if a
    // path sneaks in mixed into the name, it cannot escape the destination
    const leaf = wireBaseName(name)
    const path = wireJoin(toDir, leaf)
    if ((this.state.entries[toDir] ?? []).some((e) => e.path === path)) {
      throw Object.assign(new Error(`${path} already exists — nothing was written`), { code: 'internal' })
    }
    this.state.entries[toDir] = [
      ...(this.state.entries[toDir] ?? []),
      { name: leaf, path, isDir: false, ignored: false },
    ]
    this.state.files[path] = atob(dataBase64)
    return { path }
  }

  /** Removes the entry and everything under it; throws, removing nothing, when the path is outside or gone */
  trash(path: string): void {
    this.requireInside(path)
    /*
     * The project root (`'.'`) is **not an entry** in the listing — entries are the things
     * inside the root. In the real thing, the host's resolveExisting stats the root and lets
     * it through (it is a real folder), so rejecting it here as "no such entry" would make
     * the mock **stricter** than the real thing — the path of deleting the whole project
     * folder would end up blocked in e2e only.
     */
    if (wireSegments(path).every((seg) => seg === '' || seg === '.')) {
      this.state.entries = {}
      this.state.files = {}
      return
    }
    if (!this.detach(path))
      throw Object.assign(new Error(`${path} is no longer there`), { code: 'internal' })
    this.takeSubtree(path)
  }
}
