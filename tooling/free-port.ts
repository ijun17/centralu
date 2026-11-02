import { randomInt } from 'node:crypto'
import { createServer } from 'node:net'

// A port from `listen(0)` comes from the ephemeral range (Linux 32768-60999, macOS and Windows 49152-65535), which every outgoing
// connection of every test process draws from too: one can take it between the probe closing and a child's `listen` (run
// 41315618572, "Port 39501 is already in use"). The host hands per-app view origins out of 20000-32767 (views/origin-ports.ts),
// and `centralu serve` keeps to 17175 and the twenty above it (serve-port.mjs). This range overlaps none of them, nor
// origin-ports.test.ts's own (10000-11999); only another caller of this helper draws from it.
const [LOW, HIGH] = [12000, 16999]
const given = new Set<number>()

/** A port nobody listens on right now, for a child process to listen on (a product that cannot be told port 0). */
/** `start`: where in the range to begin looking, a random place unless a test says where. */
export async function freePort(start = randomInt(HIGH - LOW + 1)): Promise<number> {
  const size = HIGH - LOW + 1
  for (let i = 0; i < size; i++) {
    const port = LOW + ((start + i) % size)
    // Taken before the probe: a call that starts while this one waits must not pick it too
    if (given.has(port)) continue
    given.add(port)
    const probe = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', resolve)
      })
    } catch (e) {
      // In use, or reserved by Windows (Hyper-V, WSL): the next one
      given.delete(port)
      if (e instanceof Error && 'code' in e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) continue
      throw e
    }
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
  }
  throw new Error(`No free port in ${LOW}-${HIGH}`)
}
