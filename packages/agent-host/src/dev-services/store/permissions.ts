import type Database from 'better-sqlite3'
import { ProjectConsentKind } from '@cc/protocol'

// What a remembered consent allows (#371): the protocol's kinds, which the settings screen names and revokes
export type { ProjectConsentKind }

/**
 * One remembered "always" from one project to another (#371, migration v44), as the table holds it. Not the protocol's
 * `ProjectConsent`: that is a row of Settings' list, with the projects' names as they are now and the machine that keeps it.
 */
export type ConsentRow = { fromProjectId: string; toProjectId: string; kind: ProjectConsentKind; decidedAt: number }

/** One row of app_permissions — the same shape as the runtime's `CapabilityDecision` (locked together structurally, M4 D-4) */
export type AppPermissionRecord = { capability: string; text: string; decision: 'allow' | 'deny'; stamp: string; decidedAt: number }

/** One row of approval_rules, as the settings screen lists it */
export type ApprovalRuleRow = {
  id: number
  scope: string
  matcher: string
  decision: string
  projectId: string | null
  sessionId: string | null
  createdAt: number
}

/** What the person has answered: "always" rules, an app's capability requests, and one project reaching another */
export class PermissionRecords {
  constructor(private readonly db: Database.Database) {}

  addApprovalRule(r: {
    scope: string
    projectId?: string
    sessionId?: string
    matcher: string
    decision: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO approval_rules (scope, project_id, session_id, matcher, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.scope, r.projectId ?? null, r.sessionId ?? null, r.matcher, r.decision, Date.now())
  }

  listApprovalRules(): ApprovalRuleRow[] {
    return this.db
      .prepare<unknown[], ApprovalRuleRow>(
        `SELECT id, scope, matcher, decision, project_id as projectId, session_id as sessionId,
                created_at as createdAt
         FROM approval_rules
         WHERE session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE deleted_at IS NOT NULL)
         ORDER BY created_at DESC`,
      )
      .all()
  }

  /**
   * Deletes every "always allow" rule whose matcher ends in `*` (#838): a build before #908 read such a rule as a prefix.
   * Since #908 a command ending in `*` has no key and a rule matches exactly, so none of them allows anything; left in
   * the store, they would widen again under a build that reads them as before. Deleting only narrows: an older build serving the same
   * store asks for those commands again. Returns how many went.
   */
  dropWildcardApprovalRules(): number {
    return this.db.prepare(`DELETE FROM approval_rules WHERE substr(matcher, -1) = '*'`).run().changes
  }

  /** A rule has to be deletable — saving without being able to delete would make "show the outcome" only half true */
  deleteApprovalRule(id: number): void {
    this.db.prepare(`DELETE FROM approval_rules WHERE id = ?`).run(id)
  }

  // ── The person's answers to an app's capability requests (M4 D-4) — this store fills in the runtime's `CapabilityBook` ──

  getAppPermission(appKey: string, capability: string): AppPermissionRecord | null {
    const row = this.db
      .prepare<unknown[], AppPermissionRecord>(
        `SELECT capability, text, decision, uses_stamp as stamp, decided_at as decidedAt FROM app_permissions WHERE app_key = ? AND capability = ?`,
      )
      .get(appKey, capability)
    return row ?? null
  }

  putAppPermission(appKey: string, projectId: string | null, r: AppPermissionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO app_permissions (app_key, project_id, capability, text, decision, uses_stamp, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(appKey, projectId, r.capability, r.text, r.decision, r.stamp, r.decidedAt)
  }

  forgetAppPermission(appKey: string, capability: string): void {
    this.db.prepare(`DELETE FROM app_permissions WHERE app_key = ? AND capability = ?`).run(appKey, capability)
  }

  listAppPermissions(appKey: string): AppPermissionRecord[] {
    return this.db
      .prepare<unknown[], AppPermissionRecord>(
        `SELECT capability, text, decision, uses_stamp as stamp, decided_at as decidedAt FROM app_permissions WHERE app_key = ? ORDER BY decided_at DESC`,
      )
      .all(appKey)
  }

  // ── The person's "always" for one project reaching another (#371) — see migration v44 ──

  getProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): ConsentRow | null {
    const row = this.db
      .prepare<unknown[], ConsentRow>(
        `SELECT from_project_id as fromProjectId, to_project_id as toProjectId, kind, decided_at as decidedAt
           FROM project_consents WHERE from_project_id = ? AND to_project_id = ? AND kind = ?`,
      )
      .get(fromProjectId, toProjectId, kind)
    return row ?? null
  }

  setProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): void {
    this.db
      .prepare(
        `INSERT INTO project_consents (from_project_id, to_project_id, kind, decided_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(from_project_id, to_project_id, kind) DO UPDATE SET decided_at = excluded.decided_at`,
      )
      .run(fromProjectId, toProjectId, kind, Date.now())
  }

  forgetProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): boolean {
    return (
      this.db
        .prepare(`DELETE FROM project_consents WHERE from_project_id = ? AND to_project_id = ? AND kind = ?`)
        .run(fromProjectId, toProjectId, kind).changes > 0
    )
  }

  /**
   * Only the kinds this build knows (#384). `kind` has no CHECK, so a newer build can add one without a breaking step;
   * a row of a kind this build cannot name is left in place for that build rather than listed here, where the settings
   * screen would show it without a label and could not revoke it (`projectConsents.revoke` takes known kinds only).
   */
  listProjectConsents(): ConsentRow[] {
    const rows = this.db
      .prepare<unknown[], ConsentRow>(
        `SELECT from_project_id as fromProjectId, to_project_id as toProjectId, kind, decided_at as decidedAt
           FROM project_consents ORDER BY decided_at DESC`,
      )
      .all()
    return rows.filter((r) => ProjectConsentKind.safeParse(r.kind).success)
  }
}
