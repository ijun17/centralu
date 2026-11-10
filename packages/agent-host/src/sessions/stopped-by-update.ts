/**
 * The paused reports kept over work an update's stop ended (#1912), by session, until a report says so: kept at the start after the update
 * (`keptOverUpdateStop`, `HostTenure`), read and let go by the report that says it (`ChildReports`), and let go with the pause
 * (`ChildOwnership.unpauseReport`). One per host, held by `ChildOwnership`; memory only, as the update that stopped the work is this start's own.
 * Its own module, as `pause-update.ts` reads `child-ownership.ts`
 */
export class StoppedByUpdate {
  private readonly sessions = new Set<string>()

  keep(sessionId: string): void {
    this.sessions.add(sessionId)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
