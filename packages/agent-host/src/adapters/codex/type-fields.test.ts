import { describe, expect, it } from 'vitest'
import { paramFields, variantFields } from './type-fields.js'

/** ThreadItem as codex-cli 0.163.0 made it: a plain union */
const PLAIN = `import type { UserInput } from "./UserInput";
export type ThreadItem = { "type": "userMessage", id: string, clientId: string | null, content: Array<UserInput>, } | { "type": "agentMessage", id: string, text: string, phase: string | null, };`

/** ...and as 0.171.0 makes it: the lifecycle times flat beside the variants, which are in an intersection */
const INTERSECTED = `/**
 * A thread item and its recorded lifecycle times, { a, b } as they go.
 */
export type ThreadItem = {
/**
 * Unix timestamp in milliseconds when the item started, if recorded.
 */
startedAtMs?: number | null,
completedAtMs?: number | null, } & ({ "type": "userMessage", id: string, clientId: string | null, content: Array<UserInput>, } | { "type": "agentMessage", moderation: string | null, id: string, text: string, });`

const names = (fields: { name: string }[] | null) => fields?.map((f) => f.name)

/** The committed type, as the generator wrote it (what the drift run reads in a fresh one) */
const COMMITTED = Object.values(import.meta.glob<string>('./generated/v2/ThreadItem.ts', { query: '?raw', import: 'default', eager: true }))[0]!

describe('the fields of a generated Codex type (#2513)', () => {
  it('reads a variant by its tag in the old shape and in the new one', () => {
    expect(names(variantFields(PLAIN, 'userMessage'))).toEqual(['id', 'clientId', 'content'])
    expect(names(variantFields(INTERSECTED, 'userMessage'))).toEqual(['id', 'clientId', 'content'])
  })

  it('reads the user message of the committed ThreadItem, whatever Codex version made it', () => {
    expect(names(variantFields(COMMITTED, 'userMessage'))).toContain('clientId')
    expect(names(variantFields(COMMITTED, 'userMessage'))).not.toContain('startedAtMs')
  })

  it('does not take a field of another variant, nor the lifecycle times, for the tagged one', () => {
    expect(names(variantFields(INTERSECTED, 'agentMessage'))).toEqual(['moderation', 'id', 'text'])
    expect(names(variantFields(INTERSECTED, 'userMessage'))).not.toContain('startedAtMs')
  })

  it('finds a field gone from its variant, and a variant gone', () => {
    const renamed = INTERSECTED.replace('clientId: string | null', 'clientMessageId: string | null')
    expect(names(variantFields(renamed, 'userMessage'))).not.toContain('clientId')
    expect(variantFields(INTERSECTED, 'hookPrompt')).toBeNull()
  })

  it('does not take an object nested in another variant for the variant, nor a tag in a comment', () => {
    const nested = `export type T = { "type": "hookPrompt", inner: { "type": "userMessage", clientId: string, }, } | { "type": "userMessage", id: string, };`
    expect(names(variantFields(nested, 'userMessage'))).toEqual(['id'])
    const commented = `export type T = /** { "type": "userMessage", clientId: string, } */ { "type": "userMessage", id: string, };`
    expect(names(variantFields(commented, 'userMessage'))).toEqual(['id'])
  })

  it('says it cannot read a variant that only names another type, and reads past a function type', () => {
    expect(variantFields(`export type T = { "type": "sleep" } & SleepItem | { "type": "x", id: string, };`, 'sleep')).toBeNull()
    expect(names(variantFields(`export type T = { "type": "x", cb: (a: string) => void, clientId: string, };`, 'x'))).toEqual(['cb', 'clientId'])
  })

  it('reads a params type, which is one object, with what is optional and without its comments', () => {
    const params = `/** doc, with a comma */\nexport type TurnStartParams = { threadId: string, /** a, b */ clientUserMessageId?: string | null, input: Array<UserInput>, };`
    expect(paramFields(params)).toEqual([
      { name: 'threadId', required: true },
      { name: 'clientUserMessageId', required: false },
      { name: 'input', required: true },
    ])
    expect(paramFields('export type Mode = "a" | "b";')).toBeNull()
  })
})
