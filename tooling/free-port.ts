import { randomInt } from 'node:crypto'
import { createServer } from 'node:net'

// Below the ephemeral ranges of Linux (32768), macOS and Windows (49152), and above the ports `centralu serve` keeps to
// (serve-port.mjs). A port from `listen(0)` comes from the ephemeral range, which every outgoing connection of every test
// process draws from too: one can take it between the probe closing and a child's `listen` (run 41315618572, "Port 39501
// is already in use"). Nothing but another test of this helper uses this range.
const [LOW, HIGH] = [20000, 29999]
const given = new Set<number>()

/** A port nobody listens on right now, for a child process to listen on (a product that cannot be told port 0). */
export async function freePort(): Promise<number> {
  const size = HIGH - LOW + 1
  const start = randomInt(size)
  for (let i = 0; i < size; i++) {
    const port = LOW + ((start + i) % size)
    if (given.has(port)) continue
    const probe = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', resolve)
      })
    } catch (e) {
      // In use, or reserved by Windows (Hyper-V, WSL): the next one
      if (e instanceof Error && 'code' in e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) continue
      throw e
    }
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    given.add(port)
    return port
  }
  throw new Error(`No free port in ${LOW}-${HIGH}`)
}
