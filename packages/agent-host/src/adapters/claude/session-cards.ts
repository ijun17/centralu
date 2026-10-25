import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { resolve } from 'node:path'
import type { ApprovalDecision, ApprovalScope, PermissionPreset, QuestionAnswer } from '@cc/protocol'
import { AlwaysAllowRules, alwaysAllowKey } from '../always-allow.js'
import type { CreateSessionOpts, EventSink } from '../contract.js'
import { claudeEditInside } from '../edit-grant.js'
import { CardIds, PendingCards } from '../session-kit.js'
import { newFile } from './new-file.js'
import { approvalDetail } from './normalize.js'
import { appToolOf, isOrchestratorTool, parseQuestions, READ_TOOLS, readTarget } from './permissions.js'

type PendingApproval = { resolve: (r: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }) => void; input: unknown }

/** What the cards read of the session they belong to */
export type CardsHost = {
  readonly sessionId: string
  readonly opts: CreateSessionOpts
  emit: EventSink
  /** This session was given Centralu's own server (#382) */
  ownServer(): boolean
  /** The preset the session is set to now (#1525): the grant of `edits` is read from it at each call */
  livePreset(): PermissionPreset
}

/**
 * The reasons the CLI gives for asking about an edit that do not stand for a decision of the person's or a safety check
 * (`decisionReason` is free text in the SDK, so only these are known to be benign): none at all, or the permission mode
 * itself asking, as it does for any edit in `default` mode. Any other reason, known or not, keeps the card (#1525).
 */
const BENIGN_ASK_REASONS: readonly RegExp[] = [/^(the )?(current )?permission mode[^.]*(requires|needs)[^.]*(approval|permission)/i]

/** Whether the `decisionReason` of an ask is empty or one of the known benign ones (`BENIGN_ASK_REASONS`) */
export const benignAskReason = (reason: string | undefined): boolean => reason === undefined || reason.trim() === '' || BENIGN_ASK_REASONS.some((re) => re.test(reason.trim()))

/**
 * A Claude session's approval and question cards: the permission callback the SDK calls (`canUseTool`), the cards it
 * raises, their answers, and their release when the CLI withdraws them or the session stops.
 */
export class ClaudeCards {
  /** Choices waiting on an answer. Unlike approvals, **more than one can be open at once**. */
  readonly questions = new PendingCards<{ resolve: (r: unknown) => void; input: Record<string, unknown> }>()
  readonly pending = new PendingCards<PendingApproval>()
  /** Auto-approval matchers. Seeded with the saved rules at session start, and grows with each 'always' response. */
  private alwaysAllow = new AlwaysAllowRules()
  /** The ids of the cards this handle raises (see `CardIds`) */
  private readonly ids = new CardIds()
  /** The person's settings have an ask rule for an editing tool (`editAskRuleExists`): no `edits` grant (#1525) */
  editAskRule = true

  constructor(private readonly host: CardsHost) {}

  /**
   * Whether the `edits` grant is on for this call (#1525): the preset it launched under is `normal`'s or `edits`'s (a
   * launch under `safe` waits for its restart), the session is set to `edits` now (read live, so lowering it takes effect at
   * once), the person's settings have no ask rule for an editing tool, and the CLI did not say this ask was forced by one
   * (`matchedAskRule`) or by a safety check (`decisionReason`).
   */
  private mayGrantEdit(launched: PermissionPreset, options?: { matchedAskRule?: unknown; decisionReason?: string }): boolean {
    if (launched !== 'normal' && launched !== 'edits') return false
    if (this.host.livePreset() !== 'edits' || this.editAskRule) return false
    if (options?.matchedAskRule) return false
    return benignAskReason(options?.decisionReason)
  }

  /**
   * The permission callback (`canUseTool`, see the query options in `ClaudeSession.start` for why auto still reaches
   * it).
   */
  async canUseTool(preset: PermissionPreset, toolName: string, toolInput: Record<string, unknown>, options?: { signal?: AbortSignal; matchedAskRule?: unknown; decisionReason?: string }): Promise<PermissionResult> {
    /*
     * **We vouch for our own tools ourselves.**
     *
     * The orchestrator's centralu tools can never reach outside the sessions this app
     * manages (only the manager ever sees them), and the actual dangerous part — what the
     * target session runs — **is already gated entirely by that session's own permission
     * settings.** Asking again here would double up approval, and the reason this feature
     * exists in the first place — issuing instructions from one window — would disappear.
     *
     * Measured: without this, even a single list read popped an approval window, and the
     * orchestrator stalled on its very first tool call.
     *
     * Checked before auto's refusal below, so it holds under every preset (#382): in auto a call reaches this
     * callback only when an `ask` rule matched, and a rule naming `mcp__centralu` (the person's, or a trusted
     * project's file) used to refuse these tools in auto while safe and normal let them through. Codex's
     * bridge is set to `approve` for the same reason (#363).
     *
     * Only when this session was given our server (#382). Without it (an agent an app stood up, the set turned
     * off in Settings) a `centralu` server can still come from the person's own `~/.claude`, and its tools
     * are not ours to vouch for.
     */
    if (isOrchestratorTool(toolName) && this.host.ownServer()) {
      return { behavior: 'allow' as const, updatedInput: toolInput }
    }
    if (preset === 'auto' && toolName !== 'AskUserQuestion') {
      return {
        behavior: 'deny' as const,
        message: `Permission to use ${toolName} was not granted (a settings "ask" rule matched; the auto preset does not ask)`,
      }
    }

    /*
     * **A read-only app tool is never asked about** (M4 decision 5).
     *
     * The criterion is the annotation the app attached to the tool (`readOnlyHint: true`),
     * and the judgment is made from the attached app's own list, not the name — a server
     * simply starting with `app-` is never trusted on its own (the lesson from #93). Every
     * other app tool goes through the ordinary approval card below: safe always asks, normal
     * asks whenever this callback is called. In auto, this callback is never reached
     * (bypassPermissions lets it through — see the measurement above). This is the same
     * criterion as Codex's `writes` approach, so the two adapters behave the same way.
     *
     * This is separate from the centralu exception above — that exception is never widened.
     *
     * `unasked` is that read-only judgment plus the two levels an app can declare for a write (`tool-risk.ts`):
     * `local` (its own data on this computer), and `routine` for the app of this session's own project under
     * `normal`. "Always" cannot do this job: an app tool's card is an `other` one, which has no rule key, so
     * nothing it remembers reaches the next call.
     */
    const appTool = appToolOf(toolName)
    if (appTool && this.host.opts.apps?.unasked(appTool.server, appTool.tool, preset, toolInput)) {
      return { behavior: 'allow' as const, updatedInput: toolInput }
    }

    /*
     * **A read of a file another project handed back** (#371 part B). ask_project grants the caller the paths
     * the delegated session named, after this process started — so not `additionalDirectories`, which is fixed
     * at launch. A read outside the working folder lands here (measured, see `readableDirs`), and the host
     * answers whether that path was granted. Only reads: a write to the same path still asks.
     */
    if (READ_TOOLS.has(toolName) && this.host.opts.mayRead) {
      const target = readTarget(toolName, toolInput)
      if (target && this.host.opts.mayRead(target)) return { behavior: 'allow' as const, updatedInput: toolInput }
    }

    /*
     * **`edits`: a file edit inside the session's folder needs no card** (#1525). Not the SDK's `acceptEdits` mode,
     * which also approves `rm`, `mv`, `sed` and the like in the folder: the mode stays `normal`'s and this one grant
     * rides on the card the SDK is about to raise. A path outside the folder (links resolved) or under a protected
     * name (`.git`, `.claude`, ...) still asks. See `edit-grant.ts`.
     */
    if (this.mayGrantEdit(preset, options) && (await claudeEditInside(this.host.opts.cwd, toolName, toolInput))) {
      return { behavior: 'allow' as const, updatedInput: toolInput }
    }

    /*
     * **A choice is a question, not an approval** (FR: AskUserQuestion).
     *
     * The path here was found by measurement (probe-askuserquestion.mts, 2026-08-18):
     *   arrives via canUseTool    yes — the arguments (question, choices) arrive whole
     *   arrives via onUserDialog  no — never called even once, no matter what kind was declared
     *   allow with the input unchanged → the CLI tries its own dialog, and the tool ends with
     *                                    "The user did not answer the questions."
     *
     * So this intercepts it here and asks the person. The answer goes back as an **allow whose
     * `updatedInput.answers` carries it** (see `answerQuestion`). That field is the SDK's own
     * ("User answers collected by the permission component", sdk-tools.d.ts), and with it filled the
     * tool finishes normally: measured 2026-09-30, the result came back with `is_error: false` as
     * `Your questions have been answered: "Pick a color"="Blue"…`, and the model replied "Blue".
     *
     * Until then the answer went back as a **deny's message**, the only other way found to hand the
     * model arbitrary text as this tool's result. The model read it correctly, but the CLI marks a
     * denied tool's result as an error, so every answered card read "Failed" (2026-09-30, the Mea
     * session).
     */
    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(toolInput)
      // If the shape is not a question, we cannot render it — never swallow it, let it flow through as usual.
      if (questions.length === 0) return { behavior: 'allow' as const, updatedInput: toolInput }
      const requestId = this.ids.next('q')
      this.host.emit({ type: 'question_request', sessionId: this.host.sessionId, requestId, questions })
      return new Promise((resolve) => {
        this.questions.set(requestId, { resolve: resolve as (r: unknown) => void, input: toolInput })
        this.releaseOnCancel(requestId, options?.signal)
      })
    }
    // Whether a Write makes a new file is said on its card (#843), read without holding the host up (`newFile`)
    const target = toolName === 'Write' && typeof toolInput.file_path === 'string' ? toolInput.file_path : ''
    const detail = approvalDetail(toolName, toolInput, this.host.opts.cwd, target ? await newFile(resolve(this.host.opts.cwd, target)) : undefined)
    /*
     * The rule's key — for a command it is the full command text, for a file edit it is
     * **the path** (#170). This matches what the UI carries on "always allow" (both come
     * from protocol's `alwaysAllowKey`, #428), and the Codex adapter looks
     * things up by the same rule. This used to look up an edit by `Edit:file_edit`, so a
     * rule saved by path could never match — the same file was asked about again every time
     * it was edited again. Other kinds (`other`) have no key at all: what "always" would
     * even mean for them has not been decided yet.
     */
    const key = alwaysAllowKey(detail)
    if (key && this.alwaysAllow.allows(key)) return { behavior: 'allow' as const, updatedInput: toolInput }

    const requestId = this.ids.next('req')
    this.host.emit({ type: 'approval_request', sessionId: this.host.sessionId, requestId, detail })
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve: resolve as PendingApproval['resolve'], input: toolInput })
      this.releaseOnCancel(requestId, options?.signal)
    })
  }

  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): boolean {
    const p = this.pending.take(requestId)
    // Swapping the process empties this map and it starts fresh — the id of a card that came up before then is no longer here.
    if (!p) return false
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: 'Denied by user' })
    } else {
      // The matcher is computed by core and sent by the UI (agent-host never imports core — a boundary rule).
      // None given remembers nothing (always-allow.ts)
      if (decision === 'always' && matcher) this.alwaysAllow.add(matcher)
      p.resolve({ behavior: 'allow', updatedInput: p.input })
    }
    this.host.emit({ type: 'approval_resolved', sessionId: this.host.sessionId, requestId, decision })
    void scope // Per-scope persistence is recorded to the store by the session manager.
    return true
  }

  /**
   * Answers a choice. The same rule as approval — **returns whether it was reached.**
   *
   * The answer goes back as an allow with `updatedInput.answers`: the question's text mapped to the chosen labels,
   * several of them joined with ", " as the SDK describes for multi-select. The tool then finishes as a success and
   * the model receives the answers in the CLI's own words (see the AskUserQuestion branch of `canUseTool`).
   */
  answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean {
    const open = this.questions.take(requestId)
    if (!open) return false
    const byQuestion = Object.fromEntries(answers.map((a) => [a.question, a.answers.join(', ')]))
    open.resolve({ behavior: 'allow', updatedInput: { ...open.input, answers: byQuestion } })
    this.host.emit({ type: 'question_resolved', sessionId: this.host.sessionId, requestId })
    return true
  }

  /** Injects saved rules (so "always allow" survives a restart). */
  applyRules(matchers: readonly string[]): void {
    this.alwaysAllow.addAll(matchers)
  }

  /**
   * Closes a card when the CLI withdraws its question. The SDK aborts the callback's `signal` when the CLI sends
   * `control_cancel_request` for that permission request (the tool was aborted, or the turn ended without our Stop)
   * and when the query closes. Nothing else tells us: without this the card stayed open forever, and answering it
   * resolved a promise nobody was waiting on. A card already answered or released is no longer in its map, so this
   * closes nothing twice.
   */
  private releaseOnCancel(requestId: string, signal: AbortSignal | undefined): void {
    if (!signal) return
    const release = () => {
      const thisCard = (_: unknown, id: string) => id === requestId
      this.releaseApprovals('Cancelled by Claude Code', thisCard)
      this.releaseQuestions('Cancelled by Claude Code', thisCard)
    }
    if (signal.aborted) release()
    else signal.addEventListener('abort', release, { once: true })
  }

  /** Releases approvals still waiting on an answer (all, or the ones `match` picks) as denied — **never silently** */
  releaseApprovals(why: string, match?: (card: PendingApproval, requestId: string) => boolean): void {
    this.pending.release((requestId, p) => {
      p.resolve({ behavior: 'deny', message: why })
      this.host.emit({ type: 'approval_resolved', sessionId: this.host.sessionId, requestId, decision: 'deny' })
    }, match)
  }

  /** Releases a choice that was still waiting on an answer — **never released silently**, for the same reason as approval. */
  releaseQuestions(why: string, match?: (card: unknown, requestId: string) => boolean): void {
    // Closed without an answer: a deny, so the tool's result reads as the failure it is
    this.questions.release((requestId, open) => {
      open.resolve({ behavior: 'deny', message: why })
      this.host.emit({ type: 'question_resolved', sessionId: this.host.sessionId, requestId })
    }, match)
  }
}
