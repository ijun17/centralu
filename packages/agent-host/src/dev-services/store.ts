import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ProjectInfo, SessionInfo, StoredMessage, ToolDefaults } from '@cc/protocol'
import { AppRunRecords, type AppRunRecord } from './store/app-runs.js'
import { ChildOwnershipRecords, type QueuedRequest } from './store/child-ownership.js'
import { GridRecords } from './store/grid.js'
import { HandoffMarkers } from './store/handoff-markers.js'
import { LinkedMachineRecords, type LinkedMachineRow } from './store/linked-machines.js'
import { MessageRecords, type ReadOpts } from './store/messages.js'
import { MigrationRunner, type StoreInspection, type StoreOptions } from './store/migrate-runner.js'
import { type MigrationStep } from './store/migrations/context.js'
import { migrationSteps } from './store/migrations/index.js'
import {
  PermissionRecords,
  type AppPermissionRecord,
  type ConsentRow,
  type ProjectConsentKind,
} from './store/permissions.js'
import { ProjectRecords } from './store/projects.js'
import { StoreTooNewError, storeTooNewMessage } from './store/reader-gate.js'
import { SessionRecords } from './store/sessions.js'
import { SettingsRecords } from './store/settings.js'
import { TrashRecords, type TrashedRow, type TrashRecord } from './store/trash.js'

// The shapes the store hands out are defined beside the code that reads them; they are named here as they always were
export type {
  AppPermissionRecord,
  AppRunRecord,
  LinkedMachineRow,
  ConsentRow,
  ProjectConsentKind,
  QueuedRequest,
  ReadOpts,
  StoreInspection,
  StoreOptions,
  TrashedRow,
  TrashRecord,
}

// The migration runner and the reader gate `Store` stands on are named here as they always were
export { StoreTooNewError, storeTooNewMessage }

/**
 * Where the schema lives depends on how the process is running.
 * Dev (tsx) reads it from the source tree; the bundled (shipped `.app`) build reads it next to
 * the build output — the source path does not exist after bundling, so the candidates are
 * tried in order (F-0).
 */
function resolveSchemaPath(): string {
  const candidates = [
    new URL('./schema.sql', import.meta.url), // bundled output layout
    new URL('../../../protocol/src/schema/schema.sql', import.meta.url), // source tree
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`schema.sql not found: ${candidates.join(', ')}`)
  return found
}

const SCHEMA_PATH = resolveSchemaPath()

/**
 * The dev-only store (docs/agent-host.md §5). Replaced by rusqlite once the app moves to
 * Tauri; the schema file (protocol/src/schema/schema.sql) is shared as-is.
 */
export class Store extends MigrationRunner {
  protected db: Database.Database
  readonly projects: ProjectRecords
  private readonly sessions: SessionRecords
  readonly grid: GridRecords
  private readonly messages: MessageRecords
  readonly handoffs: HandoffMarkers
  private readonly trash: TrashRecords
  readonly settings: SettingsRecords
  private readonly permissions: PermissionRecords
  readonly appRuns: AppRunRecords
  private readonly children: ChildOwnershipRecords
  readonly machines: LinkedMachineRecords

  constructor(
    protected readonly dbPath = ':memory:',
    protected readonly opts: StoreOptions = {},
  ) {
    super()
    const path = dbPath
    this.db = new Database(path)
    this.projects = new ProjectRecords(this.db)
    this.sessions = new SessionRecords(this.db)
    this.grid = new GridRecords(this.db)
    this.messages = new MessageRecords(this.db)
    this.handoffs = new HandoffMarkers(this.db)
    this.settings = new SettingsRecords(this.db)
    this.trash = new TrashRecords(this.db, this.sessions)
    this.permissions = new PermissionRecords(this.db)
    this.appRuns = new AppRunRecords(this.db)
    this.children = new ChildOwnershipRecords(this.db)
    this.machines = new LinkedMachineRecords(this.db, this.settings)
    try {
      /*
       * Before anything writes: not the WAL switch, not schema.sql, not a migration. schema.sql alone would already
       * recreate, empty, whatever a newer build dropped (v13's lesson), so a store this host cannot read is left exactly
       * as the newer build wrote it.
       */
      this.refuseIfTooNew()
      this.db.pragma('journal_mode = WAL')
      /*
       * Set here rather than left to how better-sqlite3 happens to be built (#396). CASCADE on project and session
       * deletion depends on `foreign_keys`, which plain SQLite (and rusqlite, the planned replacement) leaves off.
       * `synchronous = FULL` is what better-sqlite3's build already gave in WAL mode, kept on purpose: NORMAL can lose
       * the last commits on power loss or an OS crash, and those are conversations, the data the store must not lose.
       * `busy_timeout` is the library's default made visible.
       */
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('synchronous = FULL')
      this.db.pragma('busy_timeout = 5000')
      /*
       * A checkpoint that resets the WAL also cuts the file back to this. Without a limit the WAL keeps the size of the
       * largest transaction it ever held until the next TRUNCATE, at open or close: after a swap's deferred VACUUM
       * (146 MB measured) that was the rest of a host's life, and under the keeper a host lives for days.
       */
      this.db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT}`)
      this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
      this.migrate()
    } catch (e) {
      /*
       * A store that is refused or fails a step is closed before the error leaves: nobody holds this object to close it
       * later. On Windows an open file cannot be deleted or renamed, so the handle would keep store.db (and its -wal)
       * locked until the process ended (#14).
       */
      this.db.close()
      throw e
    }
    /*
     * Fold any inherited WAL here. Measured (2026-08-26): a 91MB store.db sat next to a
     * 97MB store.db-wal — bigger than the database itself. close() folds the WAL, but if the
     * host is SIGKILLed before it reaches close() on the app's shutdown path (as with the old
     * Tauri 300ms budget), the WAL survives untouched until the next run. Fold once on start
     * and once on close — whichever side fails to run, the other side still folds it.
     */
    this.checkpoint()
  }

  /**
   * Folds the WAL into the main database and truncates the file to zero. Returns whether it did: a failure is not
   * fatal, and it is tried again at the next open or close.
   *
   * It never waits. With another connection reading, a TRUNCATE checkpoint waits out the whole busy timeout (5 s,
   * measured) on the event loop and then reports busy rather than throwing, which is longer than the 3 s a host has to
   * shut down (#396).
   *
   * On a closed store it does nothing and says so: a shutdown path that closes the store twice must not throw on the
   * second close, where it would hide why the shutdown went wrong.
   */
  checkpoint(): boolean {
    if (!this.db.open) return false
    const wait = this.db.pragma('busy_timeout', { simple: true }) as number
    try {
      this.db.pragma('busy_timeout = 0')
      const [row] = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
      return row?.busy === 0
    } catch {
      return false
    } finally {
      this.db.pragma(`busy_timeout = ${wait}`)
    }
  }

  /** The migration list. `store/migrations/index.ts` holds it, and the rule a new step follows */
  protected migrationSteps(): MigrationStep[] {
    return migrationSteps({
      getDb: () => this.db,
      vacuumAfterStep: (report) => this.vacuumAfterStep(report),
    })
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  close() {
    this.checkpoint()
    this.db.close()
  }

  /*
   * Everything below only passes the call on to the module named in its heading, which holds the code and the comment
   * that says what it does. The methods stay here so that no caller names a module.
   */

  // ── ProjectRecords (store/projects.ts) ──

  listProjects(): Omit<ProjectInfo, 'git' | 'commands' | 'defaultModels'>[] {
    return this.projects.listProjects()
  }

  worktreeSetup(projectId: string): { command: string; copyFiles: string[] } | null {
    return this.projects.worktreeSetup(projectId)
  }

  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    return this.projects.setWorktreeSetup(projectId, setup)
  }

  projectToolDefaults(projectId: string): Record<string, ToolDefaults> {
    return this.projects.projectToolDefaults(projectId)
  }

  // ── SessionRecords (store/sessions.ts) ──

  upsertSession(s: SessionInfo): void {
    return this.sessions.upsertSession(s)
  }

  setSessionOrder(orderedIds: readonly string[]): void {
    return this.sessions.setSessionOrder(orderedIds)
  }

  orchestratorId(): string | null {
    return this.sessions.orchestratorId()
  }

  listSessions(): SessionInfo[] {
    return this.sessions.listSessions()
  }

  sessionCwd(sessionId: string): string | null {
    return this.sessions.sessionCwd(sessionId)
  }

  setSessionCwd(sessionId: string, cwd: string): void {
    return this.sessions.setSessionCwd(sessionId, cwd)
  }

  setTouchedPaths(sessionId: string, paths: string[]): void {
    return this.sessions.setTouchedPaths(sessionId, paths)
  }

  getTouchedPaths(sessionId: string): string[] {
    return this.sessions.getTouchedPaths(sessionId)
  }

  recordCommit(projectId: string, sha: string, sessionId: string): void {
    return this.sessions.recordCommit(projectId, sha, sessionId)
  }

  commitSessions(projectId: string): { sha: string; sessionId: string }[] {
    return this.sessions.commitSessions(projectId)
  }

  markRead(sessionId: string, seq: number): void {
    return this.sessions.markRead(sessionId, seq)
  }

  // ── MessageRecords (store/messages.ts) ──

  appendMessages(msgs: StoredMessage[]): void {
    return this.messages.appendMessages(msgs)
  }

  searchMessages(query: string, limit?: number): { sessionId: string; seq: number; body: string }[] {
    return this.messages.searchMessages(query, limit)
  }

  loadMessages(sessionId: string, limit?: number, beforeSeq?: number, opts?: ReadOpts): StoredMessage[] {
    return this.messages.loadMessages(sessionId, limit, beforeSeq, opts)
  }

  replyTextsContaining(sessionId: string, needle: string): string[] {
    return this.messages.replyTextsContaining(sessionId, needle)
  }

  loadMessagesFrom(sessionId: string, afterSeq: number, limit?: number, opts?: ReadOpts): StoredMessage[] {
    return this.messages.loadMessagesFrom(sessionId, afterSeq, limit, opts)
  }

  lastContextCut(sessionId: string): number | null {
    return this.messages.lastContextCut(sessionId)
  }

  upsertMessageNoIndex(m: StoredMessage): void {
    return this.messages.upsertMessageNoIndex(m)
  }

  appendSubagentMessage(sessionId: string, parentCallId: string, m: Pick<StoredMessage, 'role' | 'kind' | 'payload' | 'ts'>): number {
    return this.messages.appendSubagentMessage(sessionId, parentCallId, m)
  }

  loadSubagentMessages(sessionId: string, parentCallId: string, opts?: ReadOpts & { afterSeq?: number; limit?: number }): StoredMessage[] {
    return this.messages.loadSubagentMessages(sessionId, parentCallId, opts)
  }

  nextSeq(sessionId: string): number {
    return this.messages.nextSeq(sessionId)
  }

  // ── TrashRecords (store/trash.ts) ──

  trashSession(sessionId: string, record: TrashRecord, chunk?: number): Promise<boolean> {
    return this.trash.trashSession(sessionId, record, chunk)
  }

  restoreSession(sessionId: string, projectId: string | null, chunk?: number): Promise<SessionInfo | null> {
    return this.trash.restoreSession(sessionId, projectId, chunk)
  }

  purgeSession(sessionId: string, chunk?: number): Promise<boolean> {
    return this.trash.purgeSession(sessionId, chunk)
  }

  isTrashed(sessionId: string): boolean {
    return this.trash.isTrashed(sessionId)
  }

  trashedIds(): Set<string> {
    return this.trash.trashedIds()
  }

  trashedSession(sessionId: string): { session: SessionInfo; record: TrashRecord; deletedAt: number } | null {
    return this.trash.trashedSession(sessionId)
  }

  listTrash(): TrashedRow[] {
    return this.trash.listTrash()
  }

  deleteProject(projectId: string): void {
    return this.trash.deleteProject(projectId)
  }

  // ── SettingsRecords (store/settings.ts) ──

  appSetting(key: string): string | null {
    return this.settings.appSetting(key)
  }

  // ── PermissionRecords (store/permissions.ts) ──

  addApprovalRule(r: {
    scope: string
    projectId?: string
    sessionId?: string
    matcher: string
    decision: string
  }): void {
    return this.permissions.addApprovalRule(r)
  }

  dropWildcardApprovalRules(): number {
    return this.permissions.dropWildcardApprovalRules()
  }

  listApprovalRules(): {
    id: number
    scope: string
    matcher: string
    decision: string
    projectId: string | null
    sessionId: string | null
    createdAt: number
  }[] {
    return this.permissions.listApprovalRules()
  }

  deleteApprovalRule(id: number): void {
    return this.permissions.deleteApprovalRule(id)
  }

  getAppPermission(appKey: string, capability: string): AppPermissionRecord | null {
    return this.permissions.getAppPermission(appKey, capability)
  }

  putAppPermission(appKey: string, projectId: string | null, r: AppPermissionRecord): void {
    return this.permissions.putAppPermission(appKey, projectId, r)
  }

  forgetAppPermission(appKey: string, capability: string): void {
    return this.permissions.forgetAppPermission(appKey, capability)
  }

  listAppPermissions(appKey: string): AppPermissionRecord[] {
    return this.permissions.listAppPermissions(appKey)
  }

  getProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): ConsentRow | null {
    return this.permissions.getProjectConsent(fromProjectId, toProjectId, kind)
  }

  setProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): void {
    return this.permissions.setProjectConsent(fromProjectId, toProjectId, kind)
  }

  forgetProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): boolean {
    return this.permissions.forgetProjectConsent(fromProjectId, toProjectId, kind)
  }

  listProjectConsents(): ConsentRow[] {
    return this.permissions.listProjectConsents()
  }

  // ── ChildOwnershipRecords (store/child-ownership.ts) ──

  listReportMarks(): { sessionId: string; callerSessionId: string }[] {
    return this.children.listReportMarks()
  }

  setReportMark(sessionId: string, callerSessionId: string): void {
    return this.children.setReportMark(sessionId, callerSessionId)
  }

  clearReportMark(sessionId: string): void {
    return this.children.clearReportMark(sessionId)
  }

  listAgentStartRequests(): { requestId: string; callerSessionId: string; request: unknown; askedAt: number }[] {
    return this.children.listAgentStartRequests()
  }

  putAgentStartRequest(requestId: string, callerSessionId: string, request: unknown): void {
    return this.children.putAgentStartRequest(requestId, callerSessionId, request)
  }

  deleteAgentStartRequest(requestId: string): void {
    return this.children.deleteAgentStartRequest(requestId)
  }

  listDelegatedTurns(): { sessionId: string; callerSessionId: string; told: string[]; turnId: string }[] {
    return this.children.listDelegatedTurns()
  }

  setDelegatedTurn(sessionId: string, callerSessionId: string, turnId: string): void {
    return this.children.setDelegatedTurn(sessionId, callerSessionId, turnId)
  }

  setDelegatedTurnTold(sessionId: string, told: readonly string[]): void {
    return this.children.setDelegatedTurnTold(sessionId, told)
  }

  listQueuedRequests(): QueuedRequest[] {
    return this.children.listQueuedRequests()
  }

  addQueuedRequest(r: QueuedRequest): void {
    return this.children.addQueuedRequest(r)
  }

  markQueuedDelivering(id: string, at: number | null): void {
    return this.children.markQueuedDelivering(id, at)
  }

  markQueuedOpenedByAuto(id: string): void {
    return this.children.markQueuedOpenedByAuto(id)
  }

  removeQueuedRequest(id: string): void {
    return this.children.removeQueuedRequest(id)
  }

  clearDelegatedTurn(sessionId: string): void {
    return this.children.clearDelegatedTurn(sessionId)
  }

  moveChildren(from: string, to: string, move: { sessions: readonly string[]; startRequests: readonly { requestId: string; request: unknown }[]; armReports?: readonly string[]; queued?: boolean }): void {
    return this.children.moveChildren(from, to, move)
  }
}

/** What a reset WAL is cut back to (`journal_size_limit`) */
const WAL_SIZE_LIMIT = 64 * 1024 * 1024
