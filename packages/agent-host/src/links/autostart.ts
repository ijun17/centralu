import { autostartCommand, lastLine, NOT_FOUND, parseAutostart, type RemoteAutostart, type RemoteRun, type RemoteSpec } from './tunnel.js'

/**
 * Starting a linked machine's host at boot (docs/plans/remote-hub.md §10.4, owner decision 4: offered
 * per machine, off by default), over the same ssh as the link.
 *
 * The hub writes nothing itself: it runs `centralu serve --autostart on|off|status` through the lookup
 * (tunnel.ts), and the Centralu found there writes, removes or reads its own entry (a systemd user
 * unit with lingering on Linux, a scheduled task at sign-in on Windows and for WSL; `serve.mjs`). The
 * machine is the one writer of its own state (plan S12), so the toggle reads what it answered.
 */

export type AutostartAction = 'on' | 'off' | 'status'

/** Why a machine could not be asked at all, as opposed to a refusal: uninstall goes on past these */
export type AutostartUnasked = 'not_found' | 'too_old'

/** `{ v: 1, autostart: { ok, on, how, linger, message? } }`, the line `serve --autostart` prints; null when there is none */
export function parseAutostartLine(stdout: string): { ok: boolean; state: RemoteAutostart; message: string | null } | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as { v?: unknown; autostart?: { ok?: unknown; message?: unknown } }
      const state = o.v === 1 ? parseAutostart(o.autostart) : null
      if (state && typeof o.autostart?.ok === 'boolean') {
        return { ok: o.autostart.ok, state, message: typeof o.autostart.message === 'string' ? o.autostart.message : null }
      }
    } catch {
      // not the line
    }
  }
  return null
}

const FAILED: Record<AutostartAction, string> = {
  on: 'could not be set to start at boot',
  off: 'could not stop starting at boot',
  status: 'could not say whether it starts at boot',
}

/**
 * Runs `serve --autostart <action>` there and answers the machine's state after it. Rejects with a
 * sentence for the person; `reason` on the error says the machine could not be asked at all (no
 * Centralu there, or one that predates `--autostart`)
 */
export async function autostartRemote(
  c: { exec: (command: string) => Promise<RemoteRun>; spec: RemoteSpec; target: string },
  action: AutostartAction,
): Promise<RemoteAutostart> {
  const r = await c.exec(autostartCommand(c.spec, action))
  const unasked = (reason: AutostartUnasked, message: string) => Object.assign(new Error(message), { reason })
  if (r.stdout.includes(NOT_FOUND)) throw unasked('not_found', `Centralu is not installed on ${c.target}`)
  const answer = parseAutostartLine(r.stdout)
  if (!answer) {
    if (/unknown option for serve: --autostart/.test(r.stderr)) {
      throw unasked('too_old', `The Centralu on ${c.target} is too old to start at boot; update it first`)
    }
    const why = lastLine(r.stderr)
    throw new Error(`Centralu on ${c.target} gave no answer about starting at boot${why ? `: ${why}` : r.code ? ` (exit ${r.code})` : ''}`)
  }
  if (!answer.ok) throw new Error(`Centralu on ${c.target} ${FAILED[action]}: ${answer.message ?? 'no reason given'}`)
  return answer.state
}

/**
 * Uninstall's step (plan §10.5): the entry removed by the Centralu it starts, before that Centralu is
 * removed. A machine with no Centralu to ask, or one older than `--autostart`, cannot have written one
 * from here, so it is passed by; any other failure stops the uninstall before anything is removed
 */
export async function removeAutostart(c: Parameters<typeof autostartRemote>[0]): Promise<boolean> {
  try {
    await autostartRemote(c, 'off')
    return true
  } catch (err) {
    if ((err as { reason?: AutostartUnasked }).reason) return false
    throw err
  }
}
