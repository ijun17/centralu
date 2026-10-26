import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { UsageSnapshot } from '@cc/protocol'
import { softRead } from '../usage-read.js'
import { findCursor } from './install.js'

const exec = promisify(execFile)

/** The one field of `agent about` that is read; the rest of what it prints (the account's email among it) is never looked at */
const ABOUT = z.object({ subscriptionTier: z.unknown().optional() })

/**
 * Cursor's usage (#1623). Its CLI has a `/usage` command only on its interactive screen: the ACP server advertises none
 * and print mode answers nothing for it (measured, agent 2026.10.22-27dcf5f). What `agent about --format json` says is the
 * plan, `subscriptionTier` ("Free"; measured 1.6 to 2.3 s a run on Windows). No limit can be read, so the snapshot says
 * there are none (`noLimits`) and carries the plan. The command's own output is the only source: the tool's credential and
 * state files are never opened, and the account's email in that output is never kept or sent.
 */
export function parseAbout(stdout: string): UsageSnapshot {
  const about = ABOUT.parse(jsonObjectOf(stdout))
  const tier = typeof about.subscriptionTier === 'string' ? about.subscriptionTier.trim() : ''
  return { plan: tier || null, windows: [], daily: [], noLimits: true }
}

/**
 * Measured: a bare JSON object. A notice printed before or after it (even one holding a brace) is not part of it: each
 * `{` starts a candidate that ends where its braces close (strings read as strings), and the first that parses is it.
 */
function jsonObjectOf(stdout: string): unknown {
  for (let from = stdout.indexOf('{'); from >= 0; from = stdout.indexOf('{', from + 1)) {
    let depth = 0
    let inString = false
    for (let i = from; i < stdout.length; i++) {
      const c = stdout[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
      } else if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          const value: unknown = JSON.parse(stdout.slice(from, i + 1))
          if (typeof value === 'object' && value !== null) return value
        } catch {
          // Not an object: the next brace
        }
        break
      }
    }
  }
  throw new Error('`agent about` printed no JSON object')
}

const NO_LIMITS: UsageSnapshot = { plan: null, windows: [], daily: [], noLimits: true }

/** A plan changes on the order of days: five minutes keeps a panel opened often from starting Node each time */
const FRESH_MS = 5 * 60_000
const FAIL_MS = 60_000
const SOFT_MS = 3_000
const RUN_MS = 15_000

export function cursorUsageReader(): () => Promise<UsageSnapshot> {
  return softRead<UsageSnapshot>({
    freshMs: FRESH_MS,
    failMs: FAIL_MS,
    softMs: SOFT_MS,
    fallback: () => NO_LIMITS,
    onFail: (e) => console.error(`[usage] cursor: could not read the plan: ${e.message}`),
    read: async () => {
      const install = findCursor()
      if (!install) throw new Error('Cursor CLI not found')
      const r = await exec(install.command, [...install.args, 'about', '--format', 'json'], {
        timeout: RUN_MS,
        windowsHide: true,
        env: { ...process.env, ...install.env },
      })
      return parseAbout(r.stdout)
    },
  })
}
