import { z } from 'zod'
import type { UsageSnapshot, UsageWindow } from '@cc/protocol'
import type { Platform } from '../../os.js'
import { AcpConnection, AUTH_REQUIRED, METHOD_NOT_FOUND, RpcError } from '../acp/connection.js'
import { OpenedSession, PromptResult, readUpdate } from '../acp/wire.js'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'
import { startToolProcess } from '../core/tool-process.js'
import { browserFolder, usagePlace, type AgyHome, type HelperPlaces } from './agent-files.js'
import { agyLaunch } from './launch.js'
import type { AgyArchive } from './release.js'
import { agyStderrLine } from './shape.js'
import { agentSignInUrl } from './sign-in.js'

/**
 * Antigravity's limits, as its agent says them to "/usage" (docs/agent-host/usage.md): one markdown
 * message, no model turn. Read in a process of its own, never a session's, so the person's conversation holds no such
 * turn. It runs in `usage/` and opens the conversation the last read kept, so reads do not leave a conversation each
 */

/** Under the host's own 15 s on `listUsage` (`tool-queries.ts`), so the reason heard is this one */
const READ_TIMEOUT_MS = 12_000

export type UsageReadDeps = {
  spawn?: (spec: AgentSpawnSpec) => AgentProcess
  platform?: Platform
  helperPlaces?: HelperPlaces
  timeoutMs?: number
}

/** What "/usage" says of the account's limits, by model group */
export const AgyQuota = z.array(
  z.object({
    name: z.string().min(1),
    buckets: z.array(z.object({ label: z.string().min(1), remaining: z.number().min(0).max(100), resetsAt: z.iso.datetime().nullable() })).min(1),
  }),
).min(1)
export type AgyQuota = z.infer<typeof AgyQuota>

/** `signedOut`: the error for an agent that wants a sign-in (and what noting it means), the profile's own */
export async function readAgyUsage(home: AgyHome, archive: AgyArchive, signedOut: () => Error, deps: UsageReadDeps = {}): Promise<AgyQuota> {
  const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS
  const folder = await browserFolder(home, deps.platform, deps.helperPlaces)
  if (folder.browser === '') throw new Error(`Antigravity cannot say its usage: ${folder.why}`)
  const place = await usagePlace(home)
  const launch = agyLaunch(home, archive, folder)
  const proc = startToolProcess({ ...launch, cwd: place.cwd, env: { ...process.env, ...launch.env } }, deps.spawn ? { spawn: deps.spawn } : {})
  let text = ''
  /** What the agent did that "/usage" never does (a request, a tool): the answer is not taken */
  const stray = { what: null as string | null }
  let wantsSignIn = false
  let timedOut = false
  let hasUsageCommand: boolean | null = null
  const conn = new AcpConnection(
    proc,
    {
      onNotification: (method, params) => {
        const u = method === 'session/update' ? readUpdate(params) : null
        if (!u || !('update' in u)) return
        if (u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text') text += u.update.content.text ?? ''
        if (u.update.sessionUpdate === 'tool_call') stray.what ??= 'a tool call'
        if (u.update.sessionUpdate === 'available_commands_update') {
          hasUsageCommand = u.update.availableCommands.some((c) => c.name === 'usage')
        }
      },
      onRequest: async (_id, method) => {
        stray.what ??= method
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
      },
      onExit: () => {},
    },
    'Antigravity usage',
    agyStderrLine,
  )
  folder.watch((address) => {
    if (!agentSignInUrl(address)) return
    wantsSignIn = true
    void conn.dispose(500)
  })
  const timer = setTimeout(() => {
    timedOut = true
    void conn.dispose(500)
  }, timeoutMs)
  try {
    await conn.request('initialize', { protocolVersion: 1, clientInfo: { name: 'centralu', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, timeoutMs)
    const base = { cwd: place.cwd, mcpServers: [] }
    let sessionId = place.kept && (await conn.request('session/resume', { ...base, sessionId: place.kept }, timeoutMs).then(() => place.kept, () => null))
    if (!sessionId) {
      sessionId = OpenedSession.parse(await conn.request('session/new', base, timeoutMs)).sessionId ?? null
      if (!sessionId) throw new Error('Antigravity opened a conversation without an id')
      await place.keep(sessionId)
    }
    if (hasUsageCommand === false) throw new Error('Antigravity does not support "/usage" in this version')
    text = ''
    const done = PromptResult.parse(await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/usage' }] }, timeoutMs))
    if (stray.what) throw new Error(`Antigravity answered "/usage" with ${stray.what}, not its usage`)
    const reason: string = typeof done.stopReason === 'string' ? done.stopReason : ''
    if (reason !== 'end_turn') throw new Error(`Antigravity's "/usage" ended "${reason}", not with its usage`)
    return readAgyQuota(text)
  } catch (err) {
    if (wantsSignIn || (err instanceof RpcError && err.code === AUTH_REQUIRED)) throw signedOut()
    if (timedOut) throw new Error(`Antigravity did not say its usage within ${Math.round(timeoutMs / 1000)} s`)
    // The agent's own words may name the account: only its code is said
    if (err instanceof RpcError) throw new Error(`Antigravity could not say its usage (error ${err.code})`)
    throw err
  } finally {
    clearTimeout(timer)
    await conn.dispose(5000).catch(() => {})
    await folder.remove()
  }
}

const GROUP = /^- \*\*(.+)\*\*$/
const NOTE = /^\*\(.*\)\*$/
const BUCKET = /^- \*\*(.+):\*\* (\d+(?:\.\d+)?)% remaining(?: \(resets (.+)\))?$/
const RESET = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{2}):(\d{2}) UTC$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A form "/usage" was not measured to answer in: said by the kind of line, never its text, which may name the account */
function unread(what: string): Error {
  return new Error(`Antigravity's usage answer has a form Centralu does not read (${what})`)
}

/**
 * The "### Quota Limits" section of the answer (measured on 1.4.3, the answer in `recordings/antigravity-1.4.3/usage.jsonl`):
 * a group line, an optional note under it, and its limits, each "<n>% remaining (resets <Mon D, YYYY, HH:MM UTC>)" or "<n>% remaining".
 * Other sections are not read.
 */
export function readAgyQuota(markdown: string): AgyQuota {
  const groups: { name: string; buckets: { label: string; remaining: number; resetsAt: string | null }[] }[] = []
  let inQuota = false
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('### ')) {
      inQuota = line === '### Quota Limits'
      continue
    }
    if (!inQuota || line === '' || NOTE.test(line)) continue
    const bucket = BUCKET.exec(line)
    if (bucket) {
      const group = groups.at(-1)
      if (!group) throw unread('a limit before any group')
      const resetStr = bucket[3]
      let resetsAt: string | null = null
      if (resetStr) {
        const reset = RESET.exec(resetStr)
        if (!reset) throw unread('a reset time')
        const [, month, day, year, hour, minute] = reset
        if (!month || !day || !year || !hour || !minute) throw unread('a reset time')
        const at = new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hour), Number(minute)))
        resetsAt = at.toISOString()
      }
      const label = bucket[1]
      const remainingStr = bucket[2]
      if (!label || !remainingStr) throw unread('a bucket label or value')
      group.buckets.push({ label, remaining: Number(remainingStr), resetsAt })
      continue
    }
    const group = GROUP.exec(line)
    if (group && group[1]) {
      groups.push({ name: group[1], buckets: [] })
      continue
    }
    if (line.startsWith('*(') || line.startsWith('(')) continue
    throw unread('a line of a kind it does not know')
  }
  const quota = AgyQuota.safeParse(groups.filter((g) => g.buckets.length > 0))
  if (!quota.success) throw unread(groups.length === 0 ? 'no limits' : 'a group with no limits, or a value out of range')
  return quota.data
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** One window per limit, scoped to its model group: "Weekly Limit Remaining" of "Gemini Models" is "Weekly", for Gemini Models */
export function agyUsageSnapshot(quota: AgyQuota, plan: string | null): UsageSnapshot {
  const windows: UsageWindow[] = quota.flatMap((g) =>
    g.buckets.map((b) => {
      const label = b.label.replace(/\s+Limit(\s+Remaining)?$/, '')
      return { id: `${slug(g.name)}:${slug(label)}`, label, percent: 100 - b.remaining, resetsAt: b.resetsAt, scope: g.name }
    }),
  )
  return { plan, windows, daily: [] }
}
