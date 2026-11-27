import type { FsFile } from '../ports/index.js'
import { MemoryFs } from './memory-fs.js'

/** The `fs` port over MemoryFs, with the records tests read (reads, watches, trashed and revealed paths) */
export class FilesMock {
  readonly fileOps: { op: 'read' | 'reveal'; projectId: string; path: string; sessionId?: string }[] = []
  /** A session's worktree files that differ from the project's, read first as the host does (#1209) */
  readonly sessionFiles = new Map<string, Record<string, string>>()
  readonly memoryFs = new MemoryFs()
  watchedDirs = new Map<string, string[]>()
  readonly trashed: string[] = []
  readonly trashedProjects: string[] = []
  readonly revealed: string[] = []
  readonly revealedImages: string[] = []
  readonly revealedMessageFiles: { sessionId: string; path: string }[] = []

  searchError: string | null = null

  readonly fs = {
    search: async (_projectId: string, query: string, limit = 20) => {
      if (this.searchError !== null) throw new Error(this.searchError)
      return this.memoryFs.search(query, limit)
    },
    listDir: async (_projectId: string, path: string) => this.memoryFs.listDir(path),
    // Only records the set; a test emits fs_changed itself
    watch: async (projectId: string, paths: string[]) => {
      this.watchedDirs.set(projectId, [...paths])
      return { watched: paths.length }
    },
    readFile: async (projectId: string, path: string, sessionId?: string): Promise<FsFile> => {
      this.fileOps.push({ op: 'read', projectId, path, ...(sessionId ? { sessionId } : {}) })
      const own = sessionId ? this.sessionFiles.get(sessionId)?.[path] : undefined
      if (own !== undefined) return { text: own, truncated: false, binary: false, bytes: own.length }
      return this.memoryFs.readFile(path)
    },
    resolve: async (_projectId: string, path: string, _sessionId?: string) => this.memoryFs.resolve(path),
    move: async (_projectId: string, from: string, toDir: string) => this.memoryFs.move(from, toDir),
    importFile: async (_projectId: string, toDir: string, name: string, dataBase64: string) =>
      this.memoryFs.importFile(toDir, name, dataBase64),
    trash: async (_projectId: string, path: string) => {
      this.memoryFs.trash(path)
      this.trashed.push(path)
      return { supported: true }
    },
    trashProjectFolder: async (projectId: string) => {
      this.memoryFs.trash('.')
      this.trashedProjects.push(projectId)
      return { supported: true }
    },
    revealMessageImage: async (file: string) => {
      this.revealedImages.push(file)
      return { supported: true }
    },
    revealMessageFile: async (sessionId: string, path: string) => {
      this.revealedMessageFiles.push({ sessionId, path })
      return { supported: true }
    },
    reveal: async (projectId: string, path: string, sessionId?: string) => {
      this.memoryFs.requireInside(path)
      this.revealed.push(path)
      this.fileOps.push({ op: 'reveal', projectId, path, ...(sessionId ? { sessionId } : {}) })
      return { supported: true }
    },
  }
}
