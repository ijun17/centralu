import { describe, expect, it } from 'vitest'
import { askUnless, askWhen, declaredRisk, runsUnasked, type RiskTool } from './tool-risk.js'

const tool = (risk: unknown, annotations: RiskTool['annotations'] = {}, extra: Record<string, unknown> = {}): RiskTool => ({
  annotations,
  _meta: { 'centralu/risk': risk, ...extra },
})
const own = { own: true, preset: 'normal' } as const

describe('what a tool may declare about the risk of a write', () => {
  it('local needs destructiveHint: false next to it — the MCP default is destructive, so silence asks', () => {
    expect(declaredRisk(tool('local', { destructiveHint: false }))).toBe('local')
    expect(declaredRisk(tool('local', {}))).toBeNull()
    expect(declaredRisk(tool('local', { destructiveHint: true }))).toBeNull()
  })

  it('an unknown level, none, or a read-only tool declares nothing', () => {
    expect(declaredRisk(tool('safe-ish', { destructiveHint: false }))).toBeNull()
    expect(declaredRisk({ annotations: { destructiveHint: false } })).toBeNull()
    expect(declaredRisk(tool('routine', { readOnlyHint: true }))).toBeNull()
  })

  it('askWhen is an object of values, and nothing else', () => {
    expect(askWhen(tool('routine', {}, { 'centralu/askWhen': { push: true } }))).toEqual({ push: true })
    for (const bad of [true, 'push', ['push'], {}, null]) expect(askWhen(tool('routine', {}, { 'centralu/askWhen': bad }))).toBeNull()
    expect(askUnless(tool('routine', {}, { 'centralu/askUnless': { skipPrePr: '*' } }))).toEqual({ skipPrePr: '*' })
  })

  it('a value no argument could equal (a list, an object, null) makes the declaration unreadable', () => {
    for (const key of ['centralu/askWhen', 'centralu/askUnless'] as const) {
      const read = key === 'centralu/askWhen' ? askWhen : askUnless
      for (const bad of [[true], { is: 'set' }, null]) expect(read(tool('routine', {}, { [key]: { push: bad } })), JSON.stringify(bad)).toBeNull()
      // One bad value spoils the whole declaration: a good entry beside it must not make a licence
      expect(read(tool('routine', {}, { [key]: { push: true, path: ['x'] } }))).toBeNull()
    }
  })
})

describe('whether a declared write runs with no card', () => {
  it('local runs unasked under every preset and in any app: it touches only the app\'s own data', () => {
    const t = tool('local', { destructiveHint: false })
    for (const preset of ['safe', 'normal', 'auto'] as const) expect(runsUnasked(t, { own: false, preset })).toBe(true)
  })

  it('routine runs unasked only for the session\'s own project\'s app, under normal', () => {
    const t = tool('routine', { destructiveHint: true })
    expect(runsUnasked(t, own)).toBe(true)
    expect(runsUnasked(t, { own: false, preset: 'normal' })).toBe(false)
    expect(runsUnasked(t, { own: true, preset: 'safe' })).toBe(false)
  })

  it('a routine tool with askWhen asks when any named argument matches, and when the arguments are not known', () => {
    const t = tool('routine', {}, { 'centralu/askWhen': { push: true } })
    expect(runsUnasked(t, { ...own, args: { pr: 1 } })).toBe(true)
    expect(runsUnasked(t, { ...own, args: { push: false } })).toBe(true)
    expect(runsUnasked(t, { ...own, args: { push: true } })).toBe(false)
    expect(runsUnasked(t, own)).toBe(false)
    // "*" is any value that is set: a path to another checkout; one entry matching is enough
    const two = tool('routine', {}, { 'centralu/askWhen': { push: true, path: '*' } })
    expect(runsUnasked(two, { ...own, args: { pr: 1 } })).toBe(true)
    expect(runsUnasked(two, { ...own, args: { pr: 1, path: 'C:/other' } })).toBe(false)
    expect(runsUnasked(two, { ...own, args: { pr: 1, path: '' } })).toBe(true)
    expect(runsUnasked(two, { ...own, args: { push: true } })).toBe(false)
  })

  it('a routine tool with askUnless asks unless some named argument is set, and when the arguments are not known', () => {
    // open_pr: card-free only when pre-pr does not run (skipPrePr) or nothing is opened (dryRun)
    const t = tool('routine', {}, { 'centralu/askUnless': { skipPrePr: '*', dryRun: true } })
    expect(runsUnasked(t, { ...own, args: { head: 'x' } })).toBe(false)
    expect(runsUnasked(t, { ...own, args: { head: 'x', skipPrePr: '' } })).toBe(false)
    expect(runsUnasked(t, { ...own, args: { head: 'x', dryRun: false } })).toBe(false)
    expect(runsUnasked(t, { ...own, args: { head: 'x', skipPrePr: 'a fork' } })).toBe(true)
    expect(runsUnasked(t, { ...own, args: { head: 'x', dryRun: true } })).toBe(true)
    expect(runsUnasked(t, own)).toBe(false)
    // Still capped by whose app it is and the preset
    expect(runsUnasked(t, { own: false, preset: 'normal', args: { dryRun: true } })).toBe(false)
    expect(runsUnasked(t, { own: true, preset: 'safe', args: { dryRun: true } })).toBe(false)
  })

  it('askWhen and askUnless together: the call must clear both', () => {
    const t = tool('routine', {}, { 'centralu/askWhen': { path: '*' }, 'centralu/askUnless': { skipPrePr: '*' } })
    expect(runsUnasked(t, { ...own, args: { skipPrePr: 'why' } })).toBe(true)
    expect(runsUnasked(t, { ...own, args: { skipPrePr: 'why', path: 'C:/other' } })).toBe(false)
    expect(runsUnasked(t, { ...own, args: { path: 'C:/other' } })).toBe(false)
    expect(runsUnasked(t, { ...own, args: {} })).toBe(false)
  })

  it('a declaration it cannot read asks, never runs unasked', () => {
    for (const bad of ['push', ['push'], true, {}, null, 7]) expect(runsUnasked(tool('routine', {}, { 'centralu/askWhen': bad }), { ...own, args: { push: true } }), String(JSON.stringify(bad))).toBe(false)
    for (const bad of ['skipPrePr', ['skipPrePr'], {}, null, { skipPrePr: ['*'] }]) expect(runsUnasked(tool('routine', {}, { 'centralu/askUnless': bad }), { ...own, args: { skipPrePr: 'why' } }), String(JSON.stringify(bad))).toBe(false)
    // A list as a value would never match, so it must not read as "nothing to ask about"
    expect(runsUnasked(tool('routine', {}, { 'centralu/askWhen': { push: [true] } }), { ...own, args: { push: true } })).toBe(false)
    // A value of the wrong type does not match what is named, so a string "true" does not make push a no-ask
    expect(runsUnasked(tool('routine', {}, { 'centralu/askWhen': { push: true } }), { ...own, args: { push: 'true' } })).toBe(true)
  })

  it('a tool that declares nothing never runs unasked here', () => {
    expect(runsUnasked({ annotations: { destructiveHint: false } }, own)).toBe(false)
  })
})
