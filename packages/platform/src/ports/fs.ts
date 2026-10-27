import type {
  FsEntry,
  FsFile,
} from '@cc/protocol/client'

/**
 * File tree and viewer (FR-5, FR-6 / C-1).
 * Lazy listing is the principle — reads only directories that have been opened (keeps it
 * light on large repositories).
 */
export interface FsPort {
  /** File search for `@` autocomplete (within the project only) */
  search(projectId: string, query: string, limit?: number): Promise<{ path: string; name: string }[]>
  /** Reads one level only. ignored are entries caught by .gitignore (reusing what git already reports) */
  listDir(projectId: string, relPath: string): Promise<FsEntry[]>
  /**
   * Replaces the whole set of watched directories (#34). The set expanded on screen is
   * exactly the watched set.
   * Changes arrive as `fs_changed` on the event stream — this call only registers.
   */
  watch(projectId: string, paths: string[]): Promise<{ watched: number }>
  /**
   * `sessionId` (#1209): the path is that session's, read from its folder (its worktree when it has one) and refused
   * outside it. Without it, the project's own folder.
   */
  readFile(projectId: string, relPath: string, sessionId?: string): Promise<FsFile>
  /**
   * Resolve a project-relative path to the host-validated absolute path for native handoff. `sessionId` as `readFile`'s
   */
  resolve(projectId: string, relPath: string, sessionId?: string): Promise<{ path: string }>
  /**
   * Move an entry into another folder of the same project (#19, drag inside the tree).
   *
   * `toDir` is a folder (`''` is the project root), never a full path — the gesture is a
   * drop onto a row and the name never changes, which is also why renaming is not reachable
   * from here (out of scope for #19).
   *
   * **Never overwrites**: a destination that is already taken rejects, naming the
   * collision. `moved: false` means it landed where it already was — a miss, not a failure.
   */
  move(projectId: string, from: string, toDir: string): Promise<{ path: string; moved: boolean }>
  /**
   * Put a file dragged in from the desktop into the project (#19).
   *
   * Bytes, not a source path: the webview does not tell the page where a dropped file came
   * from, which is the same reason attachments already travel this way. So the original
   * stays where it was — the only direction that cannot destroy something outside the
   * project. Rejects rather than overwrite, like `move`.
   */
  importFile(projectId: string, toDir: string, name: string, dataBase64: string): Promise<{ path: string }>
  /**
   * Move to the OS trash (#18). **Not a delete** — that is the whole decision: the trash
   * stays reversible *after* the click, which is worth more than a dialog before it.
   *
   * `supported: false` comes with a reason the UI can show, the same shape `models()` uses.
   * A browser has no trash and cannot be given one.
   */
  trash(projectId: string, relPath: string): Promise<{ supported: boolean; reason?: string }>
  /**
   * Move the project's whole folder to the OS trash: "Delete project and trash folder" only (#838). The file tree's
   * `trash` never reaches the project folder; this is the one way there, and it takes no path.
   */
  trashProjectFolder(projectId: string): Promise<{ supported: boolean; reason?: string }>
  /** Show it in the desktop's file manager (#19), in `sessionId`'s folder as `readFile`'s. Unsupported in a browser, with a reason */
  reveal(projectId: string, relPath: string, sessionId?: string): Promise<{ supported: boolean; reason?: string }>
  /**
   * Show the file a `messageImage` answer named (its `file`) in the desktop's file manager. That path is the host's,
   * resolved and opened by it; the window never builds one. Unsupported in a browser, with a reason.
   */
  revealMessageImage(file: string): Promise<{ supported: boolean; reason?: string }>
}

// The file tree's and the viewer's shapes are the protocol's (`fs.listDir`, `fs.readFile`), named here as they always were
export type { FsEntry, FsFile }
