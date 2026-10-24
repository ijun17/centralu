import { describe, expect, it } from 'vitest'
import { askWhen, declaredRisk, runsUnasked, type RiskTool } from './tool-risk.js'

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

  it('a routine tool with askWhen asks when the arguments hold the named values, and when they are not known', () => {
    const t = tool('routine', {}, { 'centralu/askWhen': { push: true } })
    expect(runsUnasked(t, { ...own, args: { pr: 1 } })).toBe(true)
    expect(runsUnasked(t, { ...own, args: { push: false } })).toBe(true)
    expect(runsUnasked(t, { ...own, args: { push: true } })).toBe(false)
    expect(runsUnasked(t, own)).toBe(false)
  })

  it('a tool that declares nothing never runs unasked here', () => {
    expect(runsUnasked({ annotations: { destructiveHint: false } }, own)).toBe(false)
  })
})
