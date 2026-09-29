import type { ApprovalDetail, ApprovalScope } from '@cc/protocol'

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
 * session's card**: the inbox takes you there.
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

export function matchesRule(command: string, matcher: string): boolean {
  if (!matcher.includes('*')) return command === matcher
  const escaped = matcher.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
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
