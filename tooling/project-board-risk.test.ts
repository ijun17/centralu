import { describe, expect, it } from 'vitest'
import { askUnless, askWhen, declaredRisk, runsUnasked, type RiskTool } from '../packages/agent-host/src/apps/external/tool-risk.js'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { tools as boardTools } from '../.centralu/apps/project-board/board-tools.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { tools as ciTools } from '../.centralu/apps/project-board/ci-tools.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { tools as contributeTools } from '../.centralu/apps/project-board/contribute-tools.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { tools as decisionTools } from '../.centralu/apps/project-board/decision-tools.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { tools as queueTools } from '../.centralu/apps/project-board/queue-tools.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { tools as releaseTools } from '../.centralu/apps/project-board/release-tools.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { tools as wordsTools } from '../.centralu/apps/project-board/words-tools.mjs'

/**
 * Which of the board's writes ask a person, as the host reads what the tools declare (tool-risk.ts, docs/apps.md,
 * "A write can declare how risky it is"). The board's bookkeeping is `local`; the ordinary writes of the repository's
 * own pull requests and issues are `routine`; `release` (tag, approve), the three that merge and `edit_comment`
 * declare nothing; `rebase_stack` asks when it pushes, and `open_pr` unless it runs no code of the head. A tool
 * added without a declaration asks, as before.
 */
const ALL = { ...boardTools, ...ciTools, ...contributeTools, ...decisionTools, ...queueTools, ...releaseTools, ...wordsTools } as Record<string, { config: RiskTool }>
const own = { own: true, preset: 'normal' } as const

describe("the project board's writes and the cards they raise", () => {
  const local = ['ack', 'unqueue', 'mark_answer_recorded']
  const routine = ['comment', 'file_issue', 'open_pr', 'set_item_fields', 'add_item', 'mark_ready', 'rebase_stack']
  // The owner's call (2026-10-24): "never merge your own pull request" stays a card, and every comment of the gh login
  // is one login, so the owner's own comments cannot be told from the session's
  const merges = ['merge_when_green', 'queue_merge', 'integrate']

  it('declares the bookkeeping writes local, and the host honours it', () => {
    for (const name of local) {
      const t = ALL[name]!.config
      expect(declaredRisk(t), name).toBe('local')
      // under every preset, even in a project the person has not trusted: it touches only the app's own data
      expect(runsUnasked(t, { own: false, preset: 'safe' }), name).toBe(true)
    }
  })

  it('declares the ordinary pull request and issue writes routine, which run with no card in the project\'s own app under normal only', () => {
    for (const name of routine) {
      const t = ALL[name]!.config
      expect(declaredRisk(t), name).toBe('routine')
      // open_pr asks unless it skips pre-pr (below): the arguments that make any of them card-free are given here
      const args = name === 'open_pr' ? { skipPrePr: 'a fork' } : {}
      expect(runsUnasked(t, { ...own, args }), name).toBe(true)
      expect(runsUnasked(t, { own: false, preset: 'normal', args }), name).toBe(false)
      expect(runsUnasked(t, { own: true, preset: 'safe', args }), name).toBe(false)
    }
  })

  it('still asks for a merge, and for editing a comment: the card is the check on merging your own pull request', () => {
    for (const name of [...merges, 'edit_comment']) {
      const t = ALL[name]!.config
      expect(declaredRisk(t), name).toBeNull()
      expect(runsUnasked(t, { ...own, args: {} }), name).toBe(false)
    }
  })

  it('still asks for release, for editing the private word list, and for a push or a checkout of its own choosing', () => {
    expect(declaredRisk(ALL.release!.config)).toBeNull()
    expect(runsUnasked(ALL.release!.config, { ...own, args: { action: 'tag', confirm: true } })).toBe(false)
    // The list is the owner's guard against a leak: a session that was refused a word must not be able to remove it unasked and post again
    expect(declaredRisk(ALL.edit_private_words!.config)).toBeNull()
    expect(runsUnasked(ALL.edit_private_words!.config, { ...own, args: { remove: ['x'] } })).toBe(false)
    // rebase_stack runs git in a checkout: one the caller names is the caller's code
    expect(askWhen(ALL.rebase_stack!.config)).toMatchObject({ path: '*' })
    expect(runsUnasked(ALL.rebase_stack!.config, { ...own, args: { pr: 7 } })).toBe(true)
    expect(runsUnasked(ALL.rebase_stack!.config, { ...own, args: { pr: 7, path: 'C:/work/other' } })).toBe(false)
    expect(runsUnasked(ALL.rebase_stack!.config, { ...own, args: { pr: 7, push: true } })).toBe(false)
  })

  it('asks for open_pr unless it runs nothing of the pushed head: pre-pr runs the tests and vitest config of the head outside any sandbox', () => {
    const t = ALL.open_pr!.config
    expect(askUnless(t)).toEqual({ skipPrePr: '*', dryRun: true })
    // the ordinary call runs pre-pr, which loads whatever the session pushed
    expect(runsUnasked(t, { ...own, args: { head: 'feature', title: 't' } })).toBe(false)
    expect(runsUnasked(t, { ...own, args: { head: 'feature', prePrExempt: { revert: 'why' } } })).toBe(false)
    // skipPrePr runs none of it (the pull request is labelled deep for it), and a dry run opens nothing
    expect(runsUnasked(t, { ...own, args: { head: 'feature', skipPrePr: 'a fork' } })).toBe(true)
    expect(runsUnasked(t, { ...own, args: { head: 'feature', dryRun: true } })).toBe(true)
    // path names a checkout of the caller's choosing, whatever else is given
    expect(runsUnasked(t, { ...own, args: { head: 'feature', skipPrePr: 'a fork', path: 'C:/work/other' } })).toBe(false)
  })

  it('declares nothing on a read, and nothing else is declared', () => {
    const declared = Object.entries(ALL)
      .filter(([, t]) => t.config._meta?.['centralu/risk'] !== undefined)
      .map(([name]) => name)
      .sort()
    expect(declared).toEqual([...local, ...routine].sort())
  })
})
