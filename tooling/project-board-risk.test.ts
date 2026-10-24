import { describe, expect, it } from 'vitest'
import { askWhen, declaredRisk, runsUnasked, type RiskTool } from '../packages/agent-host/src/apps/external/tool-risk.js'
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
 * own pull requests, issues and queue are `routine`; `release` (tag, approve) declares nothing, and `rebase_stack`
 * asks when it pushes. A tool added without a declaration asks, as before.
 */
const ALL = { ...boardTools, ...ciTools, ...contributeTools, ...decisionTools, ...queueTools, ...releaseTools, ...wordsTools } as Record<string, { config: RiskTool }>
const own = { own: true, preset: 'normal' } as const

describe("the project board's writes and the cards they raise", () => {
  const local = ['ack', 'unqueue', 'mark_answer_recorded', 'edit_private_words']
  const routine = ['comment', 'edit_comment', 'file_issue', 'open_pr', 'set_item_fields', 'add_item', 'mark_ready', 'rebase_stack', 'queue_merge', 'merge_when_green', 'integrate']

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
      expect(runsUnasked(t, { ...own, args: {} }), name).toBe(true)
      expect(runsUnasked(t, { own: false, preset: 'normal', args: {} }), name).toBe(false)
      expect(runsUnasked(t, { own: true, preset: 'safe', args: {} }), name).toBe(false)
    }
  })

  it('still asks for release, and for a rebase_stack that pushes', () => {
    expect(declaredRisk(ALL.release!.config)).toBeNull()
    expect(runsUnasked(ALL.release!.config, { ...own, args: { action: 'tag', confirm: true } })).toBe(false)
    expect(askWhen(ALL.rebase_stack!.config)).toEqual({ push: true })
    expect(runsUnasked(ALL.rebase_stack!.config, { ...own, args: { pr: 7 } })).toBe(true)
    expect(runsUnasked(ALL.rebase_stack!.config, { ...own, args: { pr: 7, push: true } })).toBe(false)
  })

  it('declares nothing on a read, and nothing else is declared', () => {
    const declared = Object.entries(ALL)
      .filter(([, t]) => t.config._meta?.['centralu/risk'] !== undefined)
      .map(([name]) => name)
      .sort()
    expect(declared).toEqual([...local, ...routine].sort())
  })
})
