import type { ApprovalDecision } from '@cc/protocol'
import { AlwaysAllowRules } from '../always-allow.js'
import { insideFolder } from '../edit-grant.js'

/**
 * The decision order every tool's approvals pass (docs/plans/session-core.md §2.7, #1654): which step answers a call the
 * tool asks about, and so whether the person sees a card. One copy for every tool; each tool supplies only how it reads
 * its own call (`GrantQuery`) and raises and answers its own cards.
 *
 * The order: Centralu's own tool → the tool's steps before `auto` → `auto` → the tool's steps after it → a rule the person
 * saved ("always") → the `edits` grant inside the folder → ask. The first step that answers decides. Every step but `auto`
 * under Claude and a tool step that says so allows, so their order changes no outcome; `auto`'s deny comes after Centralu's
 * own tool on purpose (#382). The saved rule comes before the `edits` grant because it is a lookup and the grant reads the
 * disk: a call either one allows is allowed without the read, and an answer that needs no read is given at once (Codex's
 * tests pin a synchronous answer).
 */

/** What one step answered: allowed, or denied with the words the tool hands back */
export type StepAnswer = { readonly grant: 'allow' } | { readonly grant: 'deny'; readonly message?: string }

/** Which step answered: `own` Centralu's tool, `tool` one of the tool's steps, `auto`, `always`, `edits` */
export type GrantStep = 'own' | 'tool' | 'auto' | 'always' | 'edits'

/** The order's answer: a step's, or `ask` (the tool raises its card) */
export type GrantAnswer = (StepAnswer & { readonly by: GrantStep }) | { readonly grant: 'ask' }

/** A step of the tool's own: an answer, or null to go on. Synchronous unless it must wait */
export type ToolStep = () => StepAnswer | null | Promise<StepAnswer | null>

/** A call as the decision order reads it, built by the tool from its own request */
export type GrantQuery = {
  /** Centralu's own tool, vouched for under every preset (#382): Claude by name with its server given, ACP by profile */
  readonly ownTool?: boolean
  /** The tool's own steps before `auto`, in order (Claude: a read the request's turn asks about) */
  readonly before?: readonly ToolStep[]
  /** The preset the call is decided under is `auto` */
  readonly auto: boolean
  /** The tool's own steps after `auto`, in order (Claude: an app tool asked about by nobody, a read granted by another project) */
  readonly after?: readonly ToolStep[]
  /** The key a saved rule is matched against (`alwaysAllowKey`), or how to read it when the step is reached; empty: no rule can match */
  readonly alwaysAllowKey: string | (() => string)
  /** An edit the `edits` grant may allow: the folder and every path it writes. Null when the grant does not apply */
  readonly edit: { readonly folder: string; readonly paths: readonly string[] } | null
}

type Maybe<T> = T | Promise<T>
const then = <T, U>(value: Maybe<T>, next: (v: T) => Maybe<U>): Maybe<U> => (value instanceof Promise ? value.then(next) : next(value))

const ASK: GrantAnswer = { grant: 'ask' }

/** One session's grants: the order, the person's saved rules, and what `auto` answers for this tool */
export class Grants {
  private readonly rules = new AlwaysAllowRules()

  /**
   * @param auto What `auto` answers for a call that reaches the order: `deny` for Claude (in `bypassPermissions` the CLI
   *   asks only when the person's `ask` rule matched), `allow` for ACP, null for a tool whose own policy answers under
   *   `auto` so no request comes (Codex: `approvalPolicy: never`)
   */
  constructor(private readonly auto: 'allow' | 'deny' | null) {}

  /** The rules saved before this session started ("always" survives a restart) */
  applyRules(matchers: readonly string[]): void {
    this.rules.addAll(matchers)
  }

  /** A card's answer: "always" with a matcher remembers it; one without allows that call only (`always-allow.ts`) */
  answered(decision: ApprovalDecision, matcher: string | undefined): void {
    if (decision === 'always' && matcher) this.rules.add(matcher)
  }

  /** The order's answer for one call: synchronous unless a step waits (a tool step, or the `edits` grant's disk read) */
  decide(q: GrantQuery): Maybe<GrantAnswer> {
    if (q.ownTool) return { grant: 'allow', by: 'own' }
    return then(this.toolSteps(q.before ?? []), (before) => {
      if (before) return before
      if (q.auto && this.auto) return { grant: this.auto, by: 'auto' }
      return then(this.toolSteps(q.after ?? []), (after) => {
        if (after) return after
        const key = typeof q.alwaysAllowKey === 'function' ? q.alwaysAllowKey() : q.alwaysAllowKey
        if (key && this.rules.allows(key)) return { grant: 'allow', by: 'always' }
        if (!q.edit) return ASK
        const { folder, paths } = q.edit
        return insideFolder(folder, paths).then(
          (inside): GrantAnswer => (inside ? { grant: 'allow', by: 'edits' } : ASK),
          // A check that fails asks
          () => ASK,
        )
      })
    })
  }

  private toolSteps(steps: readonly ToolStep[], at = 0): Maybe<GrantAnswer | null> {
    const step = steps[at]
    if (!step) return null
    return then(step(), (answer) => (answer ? { ...answer, by: 'tool' as const } : this.toolSteps(steps, at + 1)))
  }
}
