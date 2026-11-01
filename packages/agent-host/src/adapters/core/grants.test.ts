import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { Grants, type GrantQuery, type StepAnswer, type ToolStep } from './grants.js'

/**
 * The decision order every tool's approvals pass (`grants.ts`, session-core.md §2.7): which step wins when two would
 * answer, what `auto` answers per tool, and that an answer which needs no disk read is given at once.
 */

/** The session's folder: a real one, since the `edits` grant reads the disk (a file about to be made is inside it too) */
let folder: string
beforeEach(() => {
  folder = tempRoot('grants')
})
afterEach(() => removeTree(folder))
const at = (...parts: string[]): string => [folder, ...parts].join('/')

const call = (q: Partial<GrantQuery> = {}): GrantQuery => ({ auto: false, alwaysAllowKey: '', edit: null, ...q })
const step = (answer: StepAnswer | null, seen?: string[], name = 'step'): ToolStep => () => {
  seen?.push(name)
  return answer
}
const DENY: StepAnswer = { grant: 'deny', message: 'no' }
const ALLOW: StepAnswer = { grant: 'allow' }

describe('the decision order (core/grants.ts)', () => {
  it('lets Centralu’s own tool through before anything else, under an auto that denies too (#382)', async () => {
    const seen: string[] = []
    const grants = new Grants('deny')
    expect(await grants.decide(call({ ownTool: true, auto: true, before: [step(DENY, seen)] }))).toEqual({ grant: 'allow', by: 'own' })
    expect(seen).toEqual([])
  })

  it('asks the tool’s own steps before auto, in order, and the first answer decides', async () => {
    const seen: string[] = []
    const grants = new Grants('deny')
    const q = call({ auto: true, before: [step(null, seen, 'a'), step(ALLOW, seen, 'b'), step(DENY, seen, 'c')] })
    expect(await grants.decide(q)).toEqual({ grant: 'allow', by: 'tool' })
    expect(seen).toEqual(['a', 'b'])
    expect(await grants.decide(call({ before: [step(DENY)] }))).toEqual({ grant: 'deny', message: 'no', by: 'tool' })
  })

  it('answers auto with the tool’s answer, ahead of the steps after it, a saved rule and the edits grant', async () => {
    const seen: string[] = []
    const q = call({ auto: true, after: [step(ALLOW, seen)], alwaysAllowKey: 'ls', edit: { folder, paths: [at('src', 'a.ts')] } })
    for (const auto of ['deny', 'allow'] as const) {
      const grants = new Grants(auto)
      grants.applyRules(['ls'])
      expect(await grants.decide(q)).toEqual({ grant: auto, by: 'auto' })
    }
    expect(seen).toEqual([])
  })

  it('has no auto step for a tool whose own policy answers auto: the call goes on through the order', async () => {
    const grants = new Grants(null)
    expect(await grants.decide(call({ auto: true }))).toEqual({ grant: 'ask' })
    expect(await grants.decide(call({ auto: true, after: [step(ALLOW)] }))).toEqual({ grant: 'allow', by: 'tool' })
  })

  it('does not apply auto under any other preset', async () => {
    expect(await new Grants('allow').decide(call())).toEqual({ grant: 'ask' })
    expect(await new Grants('deny').decide(call({ after: [step(ALLOW)] }))).toEqual({ grant: 'allow', by: 'tool' })
  })

  it('asks the tool’s steps after auto before a saved rule', async () => {
    const grants = new Grants(null)
    grants.applyRules(['ls'])
    expect(await grants.decide(call({ alwaysAllowKey: 'ls', after: [step(DENY)] }))).toEqual({ grant: 'deny', message: 'no', by: 'tool' })
    expect(await grants.decide(call({ alwaysAllowKey: 'ls', after: [step(null)] }))).toEqual({ grant: 'allow', by: 'always' })
  })

  it('asks the tool’s steps after auto in order, and reads the saved rule’s key only when its step is reached', async () => {
    const seen: string[] = []
    const grants = new Grants(null)
    grants.applyRules(['ls'])
    const key = () => {
      seen.push('key')
      return 'ls'
    }
    expect(await grants.decide(call({ after: [step(null, seen, 'a'), step(ALLOW, seen, 'b')], alwaysAllowKey: key }))).toEqual({ grant: 'allow', by: 'tool' })
    expect(seen).toEqual(['a', 'b'])
    expect(await grants.decide(call({ alwaysAllowKey: key }))).toEqual({ grant: 'allow', by: 'always' })
    expect(seen).toEqual(['a', 'b', 'key'])
  })

  it('allows a call a saved rule names, and only by the same text; an empty key matches nothing', async () => {
    const grants = new Grants(null)
    grants.applyRules(['ls', ''])
    expect(await grants.decide(call({ alwaysAllowKey: 'ls' }))).toEqual({ grant: 'allow', by: 'always' })
    expect(await grants.decide(call({ alwaysAllowKey: 'ls -la' }))).toEqual({ grant: 'ask' })
    expect(await grants.decide(call({ alwaysAllowKey: '' }))).toEqual({ grant: 'ask' })
  })

  it('remembers "always" with a matcher only', async () => {
    const grants = new Grants(null)
    grants.answered('allow', 'a')
    grants.answered('deny', 'b')
    grants.answered('always', undefined)
    grants.answered('always', 'c')
    for (const [key, grant] of [['a', 'ask'], ['b', 'ask'], ['c', 'allow']] as const) {
      expect((await grants.decide(call({ alwaysAllowKey: key }))).grant, key).toBe(grant)
    }
  })

  it('allows an edit inside the folder under the edits grant, and asks for one outside it', async () => {
    const grants = new Grants(null)
    expect(await grants.decide(call({ edit: { folder, paths: [at('src', 'a.ts')] } }))).toEqual({ grant: 'allow', by: 'edits' })
    expect(await grants.decide(call({ edit: { folder, paths: [at('..', 'x.ts')] } }))).toEqual({ grant: 'ask' })
    expect(await grants.decide(call({ edit: { folder, paths: [at('.git', 'config')] } }))).toEqual({ grant: 'ask' })
    expect(await grants.decide(call({ edit: { folder, paths: [] } }))).toEqual({ grant: 'ask' })
  })

  it('answers at once when no step waits: a saved rule before the edits grant’s disk read, and a card with no edit', () => {
    const grants = new Grants('allow')
    grants.applyRules([at('src', 'a.ts')])
    // The folder's disk read would allow it too; the saved rule answers first, with no read and no wait
    expect(grants.decide(call({ alwaysAllowKey: at('src', 'a.ts'), edit: { folder, paths: [at('src', 'a.ts')] } }))).toEqual({ grant: 'allow', by: 'always' })
    expect(grants.decide(call({ alwaysAllowKey: 'rm -rf src' }))).toEqual({ grant: 'ask' })
    expect(grants.decide(call({ auto: true }))).toEqual({ grant: 'allow', by: 'auto' })
    expect(grants.decide(call({ ownTool: true }))).toEqual({ grant: 'allow', by: 'own' })
    expect(grants.decide(call({ edit: { folder, paths: [at('src', 'a.ts')] } }))).toBeInstanceOf(Promise)
  })

  it('waits for a tool step that waits, and goes on after it', async () => {
    const grants = new Grants(null)
    grants.applyRules(['ls'])
    const later: ToolStep = () => Promise.resolve(null)
    const answer = grants.decide(call({ before: [later], alwaysAllowKey: 'ls' }))
    expect(answer).toBeInstanceOf(Promise)
    expect(await answer).toEqual({ grant: 'allow', by: 'always' })
  })
})
