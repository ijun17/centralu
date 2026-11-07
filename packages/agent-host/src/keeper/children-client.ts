import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { HeldIo } from '../lifecycle/keeper-held.js'

/**
 * The sockets of a keeper of beta.48 or older, for `lifecycle/keeper-held.ts` only (#1895 step 4, PR 1 review): its
 * `keeper.sock` read-only `children` op and its children service (`children.sock`), whose wire protocol is that
 * keeper's (`keeper/src/keeper/children/mod.rs` at `keeper-holding-last`). Removed with the children service (PR 2).
 */

const ASK_TIMEOUT_MS = 3000

/** The keeper serving `dataDir`, as `keeper-held.ts` asks it */
export function keeperHeldIo(dataDir: string): HeldIo {
  return {
    servesChildren: () => existsSync(join(dataDir, 'children.sock')),
    askKeeper: async (line) => (await askLines(join(dataDir, 'keeper.sock'), [line]))[0] ?? {},
    askChildren: (lines) => askLines(join(dataDir, 'children.sock'), lines),
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `lines` on one connection to `sock`, and one answer per line: each the next JSON line that comes back that is not a
 * pushed event (a control connection's `exit`). Bounded by `ASK_TIMEOUT_MS`.
 */
export function askLines(sock: string, lines: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const answers: Record<string, unknown>[] = []
    const c = createConnection(sock)
    let buf = ''
    let settled = false
    const done = (e: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      c.destroy()
      if (e) reject(e)
      else resolve(answers)
    }
    const timer = setTimeout(() => done(new Error(`no answer on ${sock}`)), ASK_TIMEOUT_MS)
    c.on('connect', () => c.write(lines.map((l) => `${JSON.stringify(l)}\n`).join('')))
    c.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let v: unknown
        try {
          v = JSON.parse(line)
        } catch {
          return done(new Error(`a line that is not JSON on ${sock}`))
        }
        if (!isRecord(v)) return done(new Error(`a line that is not an object on ${sock}`))
        if (typeof v.event === 'string') continue
        answers.push(v)
        if (answers.length >= lines.length) return done(null)
      }
    })
    c.on('error', (e) => done(e))
    c.on('close', () => done(answers.length >= lines.length ? null : new Error(`${sock} closed before it answered`)))
  })
}
