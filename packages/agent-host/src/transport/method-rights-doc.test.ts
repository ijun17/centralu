import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderMethodRightsDoc } from './method-rights-doc.js'
import { METHOD_RIGHTS, limitedRight } from './method-rights.js'
import { WINDOW_METHODS } from '../sessions/window-rpc.js'

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url))

describe('what the limited credential may call, written down (#1405)', () => {
  it('docs/generated/method-rights.md is what the table says (run `pnpm docs:rights` after changing a class)', () => {
    expect(readFileSync(repo('docs/generated/method-rights.md'), 'utf8')).toBe(renderMethodRightsDoc())
  })
})

/**
 * A call the orchestrator makes through the window's RPC (`callWindow`, sessions/window-rpc.ts) after a card the person
 * answers (`this.ask(`, which raises it under every preset), as the flow files write it: the method, the file and line,
 * and whether the enclosing class method raised the card before that line.
 */
type WindowCall = { method: string; at: string; carded: boolean }

function windowCalls(): WindowCall[] {
  const dir = repo('packages/agent-host/src/sessions')
  const calls: WindowCall[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const lines = readFileSync(`${dir}/${file}`, 'utf8').split('\n')
    if (!lines.some((l) => l.includes('callWindow('))) continue
    // The card helper of this file must raise its card under every preset, or a carded call proves nothing
    const helper = lines.findIndex((l) => /^ {2}private async ask\(/.test(l))
    const helperRaisesAlways = helper >= 0 && lines.slice(helper, helper + 4).some((l) => l.includes('alwaysAsk: true'))
    let start = 0
    lines.forEach((line, i) => {
      // A class member starts at two spaces of indent: everything from there to this line is its body so far
      if (/^ {2}(?:private |public |protected )?(?:async )?[A-Za-z_]\w*\(/.test(line)) start = i
      for (const m of line.matchAll(/callWindow\(\s*\w+\s*,\s*'([\w.]+)'/g))
        calls.push({ method: m[1]!, at: `${file}:${i + 1}`, carded: helperRaisesAlways && cardedBefore(lines, start, i) })
    })
  }
  return calls
}

const indent = (l: string) => l.length - l.trimStart().length

/**
 * Whether a card is raised before line `at` in the same block: a `this.ask(` between the member's start and the call
 * whose block has not closed since, read by indent (a non-blank line indented less than the ask's ends its block). A
 * card in a branch the call is not in does not count.
 */
function cardedBefore(lines: string[], start: number, at: number): boolean {
  for (let k = at; k >= start; k--) {
    if (!lines[k]!.includes('this.ask(')) continue
    const depth = indent(lines[k]!)
    if (lines.slice(k + 1, at + 1).every((l) => l.trim() === '' || indent(l) >= depth)) return true
  }
  return false
}

/**
 * Calls the orchestrator cards in some cases that the limited credential runs, each with why. Anything else the
 * orchestrator cards and the limited credential would run fails the test below: decide its class, or add it here.
 */
const REREAD = 'a read, made again after Allow to check that what the card named has not changed'
const CARDED_YET_EVERYDAY: Record<string, string> = {
  'apps.list': REREAD,
  'prefs.get': REREAD,
  'sessions.list': REREAD,
}

/**
 * Window calls whose method the flow picks from a list (`callWindow(rpc, method, …)`), which the scan does not see, with
 * the file that names them and the parameters they are carded for
 */
const NAMED_IN_A_VARIABLE: Record<string, { file: string; params: unknown }> = {
  // "Automatic updates" turned on, after its card (preferences-flow.ts, `steps`)
  'updates.setAuto': { file: 'preferences-flow.ts', params: { enabled: true } },
  'updates.setAutoApply': { file: 'preferences-flow.ts', params: { enabled: true } },
}

describe('the limited credential never runs what the orchestrator asks the person for (#1405)', () => {
  const calls = windowCalls()

  it("finds the orchestrator's window calls and the cards before them (the scan reads the flows)", () => {
    // Known carded calls (docs/agent-host.md §1.4): if the scan stops seeing them, it is the scan that broke
    const carded = new Set(calls.filter((c) => c.carded).map((c) => c.method))
    for (const m of ['trash.purge', 'trash.purgeSubagentSteps', 'trash.purgeRuns', 'projects.setTrusted', 'apps.setShared', 'prefs.set']) expect(carded, m).toContain(m)
    // And reads as uncarded what acts at once
    expect(calls.find((c) => c.method === 'trash.list')?.carded).toBe(false)
  })

  it('classifies every call made after a card as asks (or asks for some parameters), unless excused with a reason', () => {
    const wrong = calls
      .filter((c) => c.carded && !(c.method in CARDED_YET_EVERYDAY))
      .filter((c) => {
        const table: Readonly<Record<string, unknown>> = METHOD_RIGHTS
        const rights = table[c.method]
        return rights === 'everyday' || rights === undefined
      })
    expect(wrong.map((c) => `${c.method} (${c.at})`), 'carded by the orchestrator yet everyday for the limited credential').toEqual([])
  })

  it('keeps every excuse current: each is still carded somewhere and still everyday', () => {
    for (const m of Object.keys(CARDED_YET_EVERYDAY)) {
      expect(calls.some((c) => c.method === m && c.carded), `${m} is no longer carded: drop its excuse`).toBe(true)
      expect(limitedRight(m, {}), `${m} is no longer everyday: drop its excuse`).toBe('everyday')
    }
  })

  it('accounts for every method the orchestrator may reach through the window', () => {
    // A method added to WINDOW_METHODS without a call the scan can see would escape the check above
    const seen = new Set([...calls.map((c) => c.method), ...Object.keys(NAMED_IN_A_VARIABLE)])
    expect(WINDOW_METHODS.filter((m) => !seen.has(m))).toEqual([])
  })

  it('judges the calls whose method is a variable the scan cannot follow by hand, and they ask', () => {
    for (const [m, where] of Object.entries(NAMED_IN_A_VARIABLE)) {
      expect(readFileSync(repo(`packages/agent-host/src/sessions/${where.file}`), 'utf8'), `${m} is no longer named in ${where.file}`).toContain(`'${m}'`)
      expect(limitedRight(m, where.params), m).toBe('asks')
    }
  })
})
