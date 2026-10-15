import { NO_PATH, type ApprovalDetail, type ApprovalScope } from '@cc/protocol'

/**
 * Approval policy (FR-3). "Don't block it, make it visible" — approving in place is not forbidden; only the
 * requests that carry too little information are marked "needs checking".
 */

/**
 * Approval policy (FR-3). "Don't block it, make it visible".
 *
 * There used to be a **banner policy** here — the rule that let an unfocused session's approval be granted
 * straight from the strip at the top of the window, but sent requests with too little information (a file
 * edit, several files, a command that was too long) back as "needs checking". When the strip itself was
 * removed (the user's request, 2026-09-10 — every time it appeared or disappeared, the whole screen was
 * pushed around), the question that rule answered went with it. An approval is now answered **on that
 * session's card**, or, where the card's question is a plain yes or no, on the waiting list's or the sidebar's row
 * that shows it (#543, `answersInPlace` below).
 */

/*
 * The folding policy for tool cards is not here.
 *
 * There was a rule, "fold lookups, unfold changes", but after only a few tool uses the conversation was
 * buried under output and the answer could not be read (dogfooding). Now **everything is folded** —
 * whatever the input, the answer is the same, so there is no longer anything to call a policy.
 * When the rules shrink to one, that rule is better expressed as a default than as code.
 */

/**
 * An "always allow" rule (FR-3). Patterns are allowed, but registering one shows a preview of what it
 * matches — instead of limiting what can be expressed, the result is made visible.
 */
export type ApprovalRule = {
  scope: ApprovalScope
  projectId?: string
  sessionId?: string
  /** A glob-like pattern: only * is supported (zero or more characters) */
  matcher: string
}

/*
 * `*` is `[\s\S]*`, not `.*`: `.` stops at a line break, so `git commit*` never matched a commit whose message
 * comes in a heredoc or a multi-line `-m`, while the host's matcher (`AlwaysAllowRules.allows`, a prefix test)
 * auto-allows exactly those. A preview built on `.*` would leave out commands the rule really lets through.
 */
export function matchesRule(command: string, matcher: string): boolean {
  if (!matcher.includes('*')) return command === matcher
  const escaped = matcher.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*')
  return new RegExp(`^${escaped}$`).test(command)
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

/** The preview of "commands this rule matches", shown when a rule is registered (FR-3) */
export function previewMatches(matcher: string, history: readonly string[]): string[] {
  return [...new Set(history.filter((c) => matchesRule(c, matcher)))]
}

/**
 * The default pattern the approval card suggests for "always allow" — the whole approved command, as is.
 *
 * Back when it widened to the first two words + '*', approving `rm -rf node_modules` suggested `rm -rf*`,
 * and `rm -rf /` very nearly got approved automatically along with it. Appending '*' to the whole command is
 * not safe either — `cmd*` is broken open by chaining such as `cmd; rm -rf /`. So the default suggestion is
 * an exact match, and widening it is left to the user, who edits it and checks the result in the preview
 * (previewMatches) first.
 */
export function suggestMatcher(command: string): string {
  return command.trim()
}

/**
 * The question a cross-project consent card asks (#371) — one sentence, the same on the card, in the conversation
 * row and in a notification, so the person reads one thing wherever it stands. The caller is named first: the card
 * stands in the caller's session, and what is being allowed is what that project may do to the other one.
 */
export function projectAccessQuestion(d: Extract<ApprovalDetail, { kind: 'project_access' }>): string {
  // An untrusted target is named as such wherever the question stands (#382): what runs there follows that trust
  const to = d.to.trusted === false ? `${d.to.name} (not trusted)` : d.to.name
  if (d.access === 'apps') return `Let ${d.from.name} use ${d.app ? `the app ${d.app.name} from ` : 'apps from '}${to}?`
  return `Let ${d.from.name} ask ${to}${d.session ? ` / ${d.session.name}` : ''} to ${d.text}?`
}

/**
 * The question a start-agent card asks (#561) — the same sentence on the card, in the conversation row and in a
 * notification: which agent, on what, and with which permissions (the caller's own, which is the most it can have).
 */
export function agentStartQuestion(d: Extract<ApprovalDetail, { kind: 'agent_start' }>): string {
  const where = d.worktree ? `${d.project.name}, in a new worktree on ${d.worktree.branch},` : `${d.project.name},`
  return `Start ${d.tool}${d.model ? ` (${d.model})` : ''} in ${where} with ${d.preset} permissions, to ${d.text}?`
}

/** The question an update card asks (#581) */
export function centraluUpdateQuestion(d: Extract<ApprovalDetail, { kind: 'centralu_update' }>): string {
  return `Allow this session to ${d.action === 'check' ? 'check for' : 'install'} a Centralu update?`
}

/**
 * The question a new-project card asks (#515) — the full path is the whole of what is being agreed to, so it is in
 * the sentence wherever the question stands: the card, the conversation row, a notification.
 */
export function projectCreateQuestion(d: Extract<ApprovalDetail, { kind: 'project_create' }>): string {
  // On a linked machine (#82) the path is that machine's: the sentence says whose disk it is
  const where = d.machine ? `${d.path} on ${d.machine}` : d.path
  if (d.source) return `Clone ${d.source.git}${d.source.branch ? ` (${d.source.branch})` : ''} into ${where} and add it as the project ${d.name}?`
  return `Make the empty folder ${where} and add it as the project ${d.name}?`
}

/**
 * What a request says beyond its command or path, one line each (#683 review): the card prints these under the
 * command, and a list row's tooltip carries them with the rest of the card's text. A request that carries any of the
 * risky ones is not answered from a row (`answersInPlace`).
 */
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
 * Whether a waiting approval can be answered from a list row (#543): the waiting list's row and the sidebar's row
 * offer Allow and Deny without opening the session, and only for a card whose question is a plain yes or no that one
 * line states whole.
 *
 * - A **command** on one line, and a **single-file edit or new file** that names its file: the line is the command or
 *   the path, the tooltip the card's whole text. Their card's "Always allow" is not on the row: what it remembers is
 *   the card's to show (the pattern, the scope).
 * - **Empty or flagged requests open the session** (#683 review): a command with no text (a network approval), input
 *   to a running terminal, network access, a command outside the sandbox, a command of several lines; an edit that
 *   names no file, a delete or a move. A row that does not show the line fits whole is the screen's to decide
 *   (`RowApproval`).
 * - Everything else opens the session instead. Starting an agent and reaching another project carry scopes and
 *   consequences the card spells out (the permissions, an untrusted target); an edit of several files is more than one
 *   path; an app's capability is remembered for good; an update relaunches things; a new project makes a folder; and
 *   `other` is a tool nobody here knows how to read.
 * - **Anything else pending** in the session (a question beside the approval) also opens it: one answer from a row
 *   would leave the person not knowing what the agent goes on to do with the other.
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
