import { wireBaseName, wireJoin, wireParent, wireSegments } from '@cc/protocol/client'
import type { FsEntry, FsFile } from '../ports/index.js'
import { mockError } from './mock-error.js'

/** The mock's file tree: the listing grouped by parent path, and the file contents by path */
export type MemoryFsState = { entries: Record<string, FsEntry[]>; files: Record<string, string> }

/** The tree and the host's rules for changing it; what the port records for tests stays on MockPlatform */
export class MemoryFs {
  state: MemoryFsState = { entries: {}, files: {} }

  /**
   * Rejected in the mock too, or e2e never sees "cannot touch outside the project" (the contract test caught it).
   * `wireSegments`, not a `/` written here, so it is the host's check (#47).
   */
  requireInside(rel: string): void {
    const fail = () => {
      throw mockError('Path is outside the project')
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

  /** A folder takes everything under it along, as on the host */
  private detach(path: string): FsEntry | null {
    const parent = wireParent(path)
    const siblings = this.state.entries[parent] ?? []
    const entry = siblings.find((e) => e.path === path)
    if (!entry) return null
    this.state.entries[parent] = siblings.filter((e) => e.path !== path)
    return entry
  }

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
   * Builds the whole path up to the file, as the host does (#104): with content alone `trash` would not find it in the
   * listing. A test faking "the agent left a note" comes in here.
   */
  place(path: string, text: string): void {
    this.state.files[path] = text
    const segs = wireSegments(path).filter(Boolean)
    for (const [i, name] of segs.entries()) {
      const here = wireJoin(...segs.slice(0, i + 1))
      const parent = wireJoin(...segs.slice(0, i))
      const list = this.state.entries[parent] ?? []
      if (list.some((e) => e.path === here)) continue
      this.state.entries[parent] = [
        ...list,
        { name, path: here, isDir: i < segs.length - 1, ignored: false },
      ]
    }
  }

  search(query: string, limit: number): { path: string; name: string }[] {
    // No real fuzzy matching: the UI flow is what is tested
    const all = Object.values(this.state.entries)
      .flat()
      .filter((e) => !e.isDir)
    const q = query.toLowerCase()
    return all
      .filter((e) => e.path.toLowerCase().includes(q))
      .slice(0, limit)
      .map((e) => ({ path: e.path, name: e.name }))
  }

  /** The host's order (dev-services/fs.ts listDir, #999), whatever order a test seeded */
  listDir(path: string): FsEntry[] {
    return [...(this.state.entries[path] ?? [])].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
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

  /** The host's `moveEntry` rules: a taken spot names the collision, no folder into itself, same place is `moved: false` */
  move(from: string, toDir: string): { path: string; moved: boolean } {
    this.requireInside(from)
    this.requireInside(toDir)
    const name = wireBaseName(from)
    const path = wireJoin(toDir, name)
    if (path === from) return { path, moved: false }
    if (path.startsWith(`${from}/`)) {
      throw mockError(`Cannot move ${name} into itself`)
    }
    if ((this.state.entries[toDir] ?? []).some((e) => e.path === path)) {
      throw mockError(`${path} already exists — nothing was moved`)
    }
    const entry = this.detach(from)
    if (!entry) throw mockError(`${from} is no longer there`)
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
    // Only the name's last segment, as the host: a path in the name cannot escape the destination
    const leaf = wireBaseName(name)
    const path = wireJoin(toDir, leaf)
    if ((this.state.entries[toDir] ?? []).some((e) => e.path === path)) {
      throw mockError(`${path} already exists — nothing was written`)
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
    // The root is no listing entry, but the host's resolveExisting lets it through: refused here, only e2e would block it
    if (wireSegments(path).every((seg) => seg === '' || seg === '.')) {
      this.state.entries = {}
      this.state.files = {}
      return
    }
    if (!this.detach(path))
      throw mockError(`${path} is no longer there`)
    this.takeSubtree(path)
  }
}
