import type { FsFile } from '../ports/index.js'
import { MemoryFs } from './memory-fs.js'

/** The `fs` port over MemoryFs, with the records tests read (reads, watches, trashed and revealed paths) */
export class FilesMock {
  /** For tests: which project a file was read from and shown for — an eye on whether the grid's neighboring-panel link goes to its own project (#182) */
  readonly fileOps: { op: 'read' | 'reveal'; projectId: string; path: string }[] = []
  readonly memoryFs = new MemoryFs()
  /** The set of watched paths registered via fs.watch (#34) — tests check what the screen asked to watch */
  watchedDirs = new Map<string, string[]>()
  /** For tests: what was sent to the trash and what was opened in the file manager (#18/#19) */
  readonly trashed: string[] = []
  readonly revealed: string[] = []
  readonly revealedImages: string[] = []

  readonly fs = {
    search: async (_projectId: string, query: string, limit = 20) => this.memoryFs.search(query, limit),
    listDir: async (_projectId: string, path: string) => this.memoryFs.listDir(path),
    // Only records the watch set — tests check the screen's reaction by emitting fs_changed directly
    watch: async (projectId: string, paths: string[]) => {
      this.watchedDirs.set(projectId, [...paths])
      return { watched: paths.length }
    },
    readFile: async (projectId: string, path: string): Promise<FsFile> => {
      this.fileOps.push({ op: 'read', projectId, path })
      return this.memoryFs.readFile(path)
    },
    resolve: async (_projectId: string, path: string) => this.memoryFs.resolve(path),
    move: async (_projectId: string, from: string, toDir: string) => this.memoryFs.move(from, toDir),
    importFile: async (_projectId: string, toDir: string, name: string, dataBase64: string) =>
      this.memoryFs.importFile(toDir, name, dataBase64),
    trash: async (_projectId: string, path: string) => {
      this.memoryFs.trash(path)
      this.trashed.push(path)
      return { supported: true }
    },
    revealMessageImage: async (file: string) => {
      this.revealedImages.push(file)
      return { supported: true }
    },
    reveal: async (projectId: string, path: string) => {
      this.memoryFs.requireInside(path)
      this.revealed.push(path)
      this.fileOps.push({ op: 'reveal', projectId, path })
      return { supported: true }
    },
  }
}
