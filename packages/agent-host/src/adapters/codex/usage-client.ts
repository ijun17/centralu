import { homedir } from 'node:os'
import { CLIENT_INFO } from '@cc/protocol'
import type { UsageSnapshot } from '@cc/protocol'
import { CodexClient } from './client.js'
import { toSnapshot } from './usage.js'

/**
 * A short-lived client for usage lookups.
 *
 * Since this is account information, unrelated to any project, it is started from the home folder.
 * Lookup traffic is not piled onto a thread that is mid-conversation — that would slow that thread
 * down, and if something fails, there would be no telling which side died.
 */
export async function readCodexUsage(command: string): Promise<UsageSnapshot> {
  const client = new CodexClient(
    { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
    { cwd: homedir(), command },
  )
  try {
    await client.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    })
    client.notify('initialized')
    const [rateLimits, usage] = await Promise.all([
      client.request<unknown>('account/rateLimits/read', undefined as never),
      // The limit can still be shown even without daily tokens — if one fails, the other survives
      client.request<unknown>('account/usage/read', undefined as never).catch(() => null),
    ])
    return toSnapshot(rateLimits, usage)
  } finally {
    await client.dispose().catch(() => {})
  }
}
