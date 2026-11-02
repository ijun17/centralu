import type { StopGate } from './stop-gate.js'

/**
 * `{"op":"stop","ifIdle":bool,"forUpdate":bool}` on the control channel: a headless keeper (`centralu serve` on Linux,
 * docs/plans/remote-keeper.md §8) asks its host to stop. Under a keeper `host.stop` is not the host's to take (the keeper
 * owns the ending), so `centralu serve --stop` and the sign-in hand-over ask the keeper, which asks the host here.
 *
 * It is `host.stop`'s own rule, answered on stdout as `{"stopAnswer":{ok,busy?,calls?}}`:
 *
 * - `ifIdle` and something runs (`StopGate.busy`): `ok: false` with what runs, nothing changed;
 * - `ifIdle` and nothing does: the gate refuses every new call from this moment (`StopGate.refuse`), in the same tick as
 *   the check, so a turn cannot start between the two; then yes;
 * - without `ifIdle`: yes.
 *
 * On yes the host stops as `host.stop` does (`stop`), listing the turns it ends for the next host when `forUpdate` (#1618).
 * The answer is written first: the keeper waits for the host to leave after it, and an ending that exits at once must
 * not take the answer with it.
 */
export function answerKeeperStop(
  m: { ifIdle?: unknown; forUpdate?: unknown },
  deps: { gate: StopGate; stop: (o: { forUpdate: boolean }) => void; write: (line: string) => void },
): void {
  if (m.ifIdle === true) {
    const busy = deps.gate.busy()
    if (busy) return deps.write(JSON.stringify({ stopAnswer: { ok: false, busy: busy.busy, calls: busy.calls } }))
    deps.gate.refuse()
  }
  deps.write(JSON.stringify({ stopAnswer: { ok: true } }))
  deps.stop({ forUpdate: m.forUpdate === true })
}
