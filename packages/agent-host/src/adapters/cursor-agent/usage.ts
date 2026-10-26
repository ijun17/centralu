import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UsageSnapshot } from '@cc/protocol'
import { softRead } from '../usage-read.js'
import { findCursor } from './install.js'

const exec = promisify(execFile)

/**
 * Cursor's usage (#1623). Its CLI has a `/usage` command only on its interactive screen: the ACP server advertises none
 * and print mode answers nothing for it (measured, agent 2026.10.22-27dcf5f). What `agent about --format json` says is the
 * plan, `subscriptionTier` ("Free"; measured 1.6 to 2.3 s a run on Windows). No limit can be read, so the snapshot says
 * there are none (`noLimits`) and carries the plan. The command's own output is the only source: the tool's credential and
 * state files are never opened, and the account's email in that output is never kept or sent.
 */
export function parseAbout(stdout: string): UsageSnapshot {
  // Measured: a bare JSON object; anything printed before or after it (a banner, a notice) is not part of it
  const from = stdout.indexOf('{')
  const to = stdout.lastIndexOf('}')
  if (from < 0 || to < from) throw new Error('`agent about` printed no JSON')
  const about = JSON.parse(stdout.slice(from, to + 1)) as { subscriptionTier?: unknown }
  const tier = typeof about.subscriptionTier === 'string' ? about.subscriptionTier.trim() : ''
  return { plan: tier || null, windows: [], daily: [], noLimits: true }
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
