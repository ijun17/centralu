import { DATA_PS, DATA_SH } from './install.js'
import { tryParseJson } from '../json-value.js'
import { remoteScript, type RemoteCommand, type RemoteSpec } from './tunnel.js'

/**
 * A hold on a linked machine while `pnpm remote-dev` swaps its host (#1036): `<data>/remote/hold.json` there. A hub's
 * link that finds no host running starts one itself (owner decision 7, plan §10.9), which during a swap would start the
 * old version between the stop and the switch, and the swap would put the old one back. The command writes the hold
 * before it stops anything and lifts it when it is done; every link (from any hub) asks for it before it starts a host,
 * and waits while it holds.
 *
 * Not an RPC: the command cannot reach the hub's host, and nothing an agent can call gains anything. The time in it is
 * the hub's own clock, which the link reads on the same computer; a hold a command left behind (it died) lapses after
 * `HOLD_MS`.
 */

export const HOLD = 'CENTRALU-HOLD'
/** How long a hold lasts unless lifted: the swap's own steps take well under it, the build is before it */
export const HOLD_MS = 10 * 60_000

export type SwapHold = { until: number; by: string }

/** Writes the hold there, or lifts it (`null`), in its shell's terms; prints `CENTRALU-HOLD done` */
export function holdCommand(spec: RemoteSpec, hold: SwapHold | null): RemoteCommand {
  if (!hold) {
    return remoteScript(spec, {
      sh: `${DATA_SH}; rm -f "$r/hold.json"; echo "${HOLD} done"\n`,
      ps: `${DATA_PS}; Remove-Item -Force (Join-Path $r 'hold.json') -ErrorAction SilentlyContinue; "${HOLD} done"\n`,
    })
  }
  const b64 = Buffer.from(JSON.stringify({ until: Math.floor(hold.until), by: hold.by.replace(/[^\w .()-]/g, '') }), 'utf8').toString('base64')
  return remoteScript(spec, {
    sh: `${DATA_SH}; mkdir -p "$r" && printf %s ${b64} | base64 -d > "$r/hold.json.tmp" && mv -f "$r/hold.json.tmp" "$r/hold.json" && echo "${HOLD} done"\n`,
    ps: `${DATA_PS}; New-Item -ItemType Directory -Force $r | Out-Null; [IO.File]::WriteAllText((Join-Path $r 'hold.json'), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); "${HOLD} done"\n`,
  })
}

/** Asks for the hold there; prints `CENTRALU-HOLD <json>` when there is one */
export function readHoldCommand(spec: RemoteSpec): RemoteCommand {
  return remoteScript(spec, {
    sh: `${DATA_SH}; if [ -f "$r/hold.json" ]; then printf '%s %s\\n' ${HOLD} "$(tr -d '\\r\\n' < "$r/hold.json")"; fi; true\n`,
    ps: `${DATA_PS}; $f = Join-Path $r 'hold.json'; if (Test-Path $f) { "${HOLD} " + ((Get-Content -Raw $f) -replace '\\s+', ' ') }\n`,
  })
}

/** The hold `readHoldCommand` printed, when it still holds at `now`; null otherwise (none, lapsed, or unreadable) */
export function parseHold(stdout: string, now: number): SwapHold | null {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith(`${HOLD} {`))
  if (!line) return null
  const o = tryParseJson(line.slice(HOLD.length + 1)) as { until?: unknown; by?: unknown } | null | undefined
  if (typeof o?.until !== 'number' || o.until <= now || o.until > now + HOLD_MS * 2) return null
  return { until: o.until, by: typeof o.by === 'string' ? o.by : 'another command' }
}
