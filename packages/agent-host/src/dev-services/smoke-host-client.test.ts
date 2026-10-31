import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SLOW } from '../../../../tooling/test-timing.js'
import { openHost, type HostClient, type Json } from '../../scripts/host-client.mjs'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'

/**
 * The client the smoke scripts share (scripts/host-client.mjs), against the real host on a temp data folder: it starts
 * the host, says hello, makes calls, keeps the events and waits for one.
 */

let data = ''
const dirs: string[] = []
let client: (HostClient & { host: { kill: () => boolean } }) | null = null
const seen: Json[] = []
beforeAll(async () => {
  data = tempRoot('cc-host-client-')
  client = await openHost({ env: { CC_DATA_DIR: data }, onEvent: (e) => seen.push(e) })
}, 60_000 * SLOW)
afterAll(async () => {
  client?.ws.close()
  client?.host.kill()
  await removeTree(data)
  for (const d of dirs) await removeTree(d)
})

describe("the smokes' host client", () => {
  it('stops the host and returns only once it is gone', async () => {
    const dir = tempRoot('cc-host-client-stop-')
    dirs.push(dir)
    const own = await openHost({ env: { CC_DATA_DIR: dir } })
    await own.stop()
    expect(own.host.exitCode !== null || own.host.signalCode !== null).toBe(true)
  }, 60_000 * SLOW)

  it('starts the host, greets it, and resolves a call with its result', async () => {
    expect(await client?.call('projects.list', {})).toEqual([])
  })

  it('rejects a call with the host\'s own error message', async () => {
    await expect(client?.call('agents.resumeSession', { sessionId: 'no-such-session' })).rejects.toThrow('Session not found: no-such-session')
  })

  it('keeps every event the host sends, hands each to onEvent, and waits for one that has come or never does', async () => {
    const first = await client?.next((e) => e.type === 'update_status', 'update_status')
    expect(first).toMatchObject({ type: 'update_status' })
    expect(client?.events).toEqual(seen)
    await expect(client?.next((e) => e.type === 'no_such_event', 'no_such_event', 50)).rejects.toThrow('no no_such_event in 50 ms')
  })
})
