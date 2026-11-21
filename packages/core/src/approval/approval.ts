import { NO_PATH, alwaysAllowKey, matchesAllowRule, oneLineText, type ApprovalDetail, type ApprovalScope } from '@cc/protocol/client'

/** Approval policy (FR-3): "don't block it, make it visible". Tool cards are all folded by default, not by a rule here. */

/** An "always allow" rule: one command, matched whole (docs/security-boundaries/approvals-from-the-assistant.md) */
export type ApprovalRule = {
  scope: ApprovalScope
  projectId?: string
  sessionId?: string
  matcher: string
}

// The host's own rule, so a preview shows exactly what the host lets through (#428)
export function matchesRule(command: string, matcher: string): boolean {
  return matchesAllowRule(alwaysAllowKey({ kind: 'command', command, cwd: '' }), matcher)
}

export function findMatchingRule(
  detail: ApprovalDetail,
  rules: readonly ApprovalRule[],
  ctx: { sessionId: string; projectId: string },
): ApprovalRule | null {
  if (detail.kind !== 'command') return null
  return (
    rules.find((r) => {
      if (r.scope === 'session' && r.sessionId !== ctx.sessionId) return false
      if (r.scope === 'project' && r.projectId !== ctx.projectId) return false
      return matchesRule(detail.command, r.matcher)
    }) ?? null
  )
}

export function previewMatches(matcher: string, history: readonly string[]): string[] {
  return [...new Set(history.filter((c) => matchesRule(c, matcher)))]
}

/**
 * The whole command: a widened `rm -rf*` would allow `rm -rf /`, and `cmd*` is opened by `cmd; rm -rf /` (#838).
 * `''` for a command ending in `*`, which an older host reads as a prefix.
 */
export function suggestMatcher(command: string): string {
  return alwaysAllowKey({ kind: 'command', command, cwd: '' })
}

/**
 * One sentence on the card, the conversation row and a notification (#371). The caller comes first: the card stands in
 * its session, and what is allowed is what it may do to the other project.
 */
export function projectAccessQuestion(d: Extract<ApprovalDetail, { kind: 'project_access' }>): string {
  // What runs there follows that trust (#382)
  const named = d.to.machine ? `${quoted(d.to.name)} on ${quoted(d.to.machine)}` : quoted(d.to.name)
  const to = d.to.trusted === false ? `${named} (not trusted)` : named
  // A session on a linked machine asking here (#550)
  const from = d.from.machine
    ? `${d.from.session ? `${quoted(d.from.session.name)} in ` : ''}${quoted(d.from.name)} on ${quoted(d.from.machine)}`
    : quoted(d.from.name)
  if (d.access === 'apps') return `Let ${from} use ${d.app ? `the app ${quoted(d.app.name)} from ` : 'apps from '}${to}?`
  return `Let ${from} ask ${to}${d.session ? ` / ${quoted(d.session.name)}` : ''} to ${d.text}?`
}

/**
 * A name another program or an agent may have chosen, quoted on one line (#838) so it cannot read as the card's own
 * words ("toolkit to read nothing? Allow").
 */
function quoted(name: string): string {
  return JSON.stringify(oneLineText(name, 120))
}

/** One sentence on the card, the conversation row and a notification (#561); the permissions are the caller's, its most */
export function agentStartQuestion(d: Extract<ApprovalDetail, { kind: 'agent_start' }>): string {
  // The Assistant's child works in no project (#853)
  const place = d.project.id ? quoted(d.project.name) : d.project.name
  const on = d.machine ? `${place} on ${quoted(d.machine)}` : place
  const where = d.worktree ? `${on}, in a new worktree on ${quoted(d.worktree.branch)},` : `${on},`
  // The person's setting picked the model, not the agent (#729)
  const model = d.model ? ` (${d.model}${d.difficulty ? `, your choice for ${d.difficulty} work` : ''})` : ''
  const named = d.name ? ` as ${quoted(d.name)}` : ''
  // Why an auto caller's child will not run auto there (#1273)
  const withheld =
    d.autoWithheld === 'machine_off'
      ? ` (not auto: ${quoted(d.machine ?? '')} does not allow auto from a linked computer)`
      : d.autoWithheld === 'older'
        ? ` (not auto: ${quoted(d.machine ?? '')} runs an older Centralu that cannot take it)`
        : ''
  return `Start ${d.tool}${model}${named} in ${where} with ${d.preset} permissions${withheld}, to ${d.text}?`
}

export function centraluUpdateQuestion(d: Extract<ApprovalDetail, { kind: 'centralu_update' }>): string {
  return `Allow this session to ${d.action === 'check' ? 'check for' : 'install'} a Centralu update?`
}

/** The full path is the whole of what is agreed to, so it is in the sentence wherever it stands (#515) */
export function projectCreateQuestion(d: Extract<ApprovalDetail, { kind: 'project_create' }>): string {
  const where = d.machine ? `${d.path} on ${d.machine}` : d.path
  if (d.source) return `Clone ${d.source.git}${d.source.branch ? ` (${d.source.branch})` : ''} into ${where} and add it as the project ${d.name}?`
  return `Make the empty folder ${where} and add it as the project ${d.name}?`
}

/** Printed under the command and in a row's tooltip (#683 review) */
export function approvalNotes(d: ApprovalDetail): string[] {
  if (d.kind === 'command') {
    return [
      ...(d.stdin ? ['Input to a terminal that is already running'] : []),
      ...(d.network ? [`Network access to ${d.network.host}${d.network.protocol ? ` (${d.network.protocol})` : ''}`] : []),
      ...(d.unsandboxed ? ['Runs outside the sandbox'] : []),
      ...(d.reason ? [`Reason: ${d.reason}`] : []),
    ]
  }
  if (d.kind === 'file_edit') {
    if (d.change === 'delete') return ['Deletes the file']
    if (d.change === 'move') return [`Moves the file to ${d.movePath ?? 'another path'}`]
    if (d.change === 'add') return ['Creates the file']
  }
  return []
}

/**
 * Allow and Deny on a waiting-list row: only a plain yes or no that one line states whole (docs/product-spec.md FR-3
 * "Answering from a row"). Whether the line fits whole is the screen's to decide (`RowApproval`).
 */
export function answersInPlace(detail: ApprovalDetail, otherPending = 0): boolean {
  if (otherPending > 0) return false
  if (detail.kind === 'command') {
    const c = detail.command.trim()
    return c !== '' && !c.includes('\n') && !detail.stdin && !detail.network && !detail.unsandboxed
  }
  if (detail.kind === 'file_edit') {
    const named = detail.path.trim() !== '' && detail.path !== NO_PATH
    return !detail.multi && named && (detail.change === undefined || detail.change === 'update' || detail.change === 'add')
  }
  return false
}
