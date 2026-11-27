import type {
  FsEntry,
  FsFile,
} from '@cc/protocol/client'

/** Lazy listing: only directories that have been opened are read, to stay light on large repositories */
export interface FsPort {
  /** `@` autocomplete, within the project only */
  search(projectId: string, query: string, limit?: number): Promise<{ path: string; name: string }[]>
  /** One level only. `ignored` reuses what git reports for .gitignore */
  listDir(projectId: string, relPath: string): Promise<FsEntry[]>
  /** Replaces the whole watched set, which is the set expanded on screen (#34); changes come as `fs_changed` events */
  watch(projectId: string, paths: string[]): Promise<{ watched: number }>
  readFile(projectId: string, relPath: string, sessionId?: string): Promise<FsFile>
  /** The host-validated absolute path for native handoff; `sessionId` as `readFile`'s */
  resolve(projectId: string, relPath: string, sessionId?: string): Promise<{ path: string }>
  /**
   * A drop onto a folder row (#19): `toDir` is a folder (`''` the root), the name never changes. Never overwrites: a
   * taken destination rejects, naming it. `moved: false`: it was already there, a miss, not a failure.
   */
  move(projectId: string, from: string, toDir: string): Promise<{ path: string; moved: boolean }>
  /**
   * A file dropped from the desktop (#19). Bytes, not a path: the webview does not tell the page where a dropped file
   * came from, so the original stays where it was. Rejects rather than overwrite.
   */
  importFile(projectId: string, toDir: string, name: string, dataBase64: string): Promise<{ path: string }>
  /** The OS trash (#18), not a delete: reversible after the click. A browser has none: `supported: false`, a reason */
  trash(projectId: string, relPath: string): Promise<{ supported: boolean; reason?: string }>
  /** The only way `trash` reaches the project folder: "Delete project and trash folder" (#838) */
  trashProjectFolder(projectId: string): Promise<{ supported: boolean; reason?: string }>
  /** In the desktop's file manager (#19), `sessionId` as `readFile`'s. Unsupported in a browser, with a reason */
  reveal(projectId: string, relPath: string, sessionId?: string): Promise<{ supported: boolean; reason?: string }>
  /** Reveals a `messageImage` answer's `file`, a path the host resolves; the window never builds one */
  revealMessageImage(file: string): Promise<{ supported: boolean; reason?: string }>
  /** Resolves a path named by a session's reply (`messages.resolveFile`) and reveals it in the file manager */
  revealMessageFile(sessionId: string, path: string): Promise<{ supported: boolean; reason?: string }>
}

export type { FsEntry, FsFile }
